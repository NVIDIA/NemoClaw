// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeNvidiaCdiDevice } from "./podman/gpu-attachment";
import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  type PodmanSocketAuthority,
} from "./podman/socket-authority";

export const MINIMUM_NATIVE_PODMAN_VERSION = "5.0.0";

export interface NativePodmanPreflightReceipt {
  readonly driverName: "podman";
  readonly version: string;
  readonly socketPath: string;
  readonly socketAuthority: PodmanSocketAuthority;
  readonly rootless: true;
  readonly cgroupVersion: "v2";
  readonly os: "linux";
  readonly architecture: "amd64" | "arm64";
  readonly networkBackend: string;
  readonly cdiDevices: readonly string[];
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface NativePodmanPreflightDeps {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly env?: NodeJS.ProcessEnv;
  readonly uid?: number;
  readonly home?: string;
  readonly lstatSync?: typeof fs.lstatSync;
  readonly assertSocketAuthority?: (expected: PodmanSocketAuthority) => void;
  readonly run?: (command: string, args: readonly string[]) => CommandResult;
}

export class NativePodmanPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativePodmanPreflightError";
  }
}

function defaultRun(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function dottedVersion(value: string): readonly number[] | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isPodmanVersionSupported(
  actual: string,
  minimum = MINIMUM_NATIVE_PODMAN_VERSION,
): boolean {
  const actualParts = dottedVersion(actual);
  const minimumParts = dottedVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < minimumParts.length; index += 1) {
    const delta = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function field(value: unknown, ...names: string[]): unknown {
  const object = record(value);
  if (!object) return undefined;
  for (const name of names) {
    if (Object.hasOwn(object, name)) return object[name];
  }
  return undefined;
}

function stringField(value: unknown, ...names: string[]): string {
  const candidate = field(value, ...names);
  return typeof candidate === "string" ? candidate.trim() : "";
}

function booleanField(value: unknown, ...names: string[]): boolean | null {
  const candidate = field(value, ...names);
  return typeof candidate === "boolean" ? candidate : null;
}

function normalizePodmanArchitecture(value: string): "amd64" | "arm64" | null {
  if (value === "amd64" || value === "x86_64") return "amd64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return null;
}

function collectCdiDevices(value: unknown, devices: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("nvidia.com/gpu=")) devices.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectCdiDevices(entry, devices);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    if (key.startsWith("nvidia.com/gpu=")) devices.add(key);
    collectCdiDevices(entry, devices);
  }
}

function parseNvidiaCdiDeviceList(output: string): string[] {
  const devices = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (!candidate.startsWith("nvidia.com/gpu=")) continue;
    try {
      devices.add(normalizeNvidiaCdiDevice(candidate));
    } catch {
      // Ignore diagnostics and malformed provider output. Requested devices
      // are still checked exactly against the resulting qualified inventory.
    }
  }
  return [...devices].sort();
}

function listNvidiaCdiDevices(
  run: NonNullable<NativePodmanPreflightDeps["run"]>,
): readonly string[] {
  const result = run("nvidia-ctk", ["cdi", "list"]);
  return result.status === 0 ? parseNvidiaCdiDeviceList(result.stdout) : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function nativePodmanSocketCandidates(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly uid?: number;
  readonly home?: string;
}): string[] {
  const env = input.env ?? process.env;
  const uid = input.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const home = input.home ?? env.HOME ?? os.homedir();
  const explicit = env.OPENSHELL_PODMAN_SOCKET?.trim();
  if (explicit) return [explicit];

  return unique(
    [
      env.XDG_RUNTIME_DIR?.trim()
        ? path.join(env.XDG_RUNTIME_DIR.trim(), "podman", "podman.sock")
        : "",
      uid >= 0 ? `/run/user/${String(uid)}/podman/podman.sock` : "",
      home ? path.join(home, ".local", "share", "containers", "podman", "podman.sock") : "",
    ].filter(Boolean),
  );
}

function assertAbsoluteSocketPath(socketPath: string, explicit: boolean): void {
  if (!path.isAbsolute(socketPath)) {
    throw new NativePodmanPreflightError(
      `${explicit ? "OPENSHELL_PODMAN_SOCKET" : "Podman socket"} must be an absolute path.`,
    );
  }
}

function parsePodmanInfo(
  output: string,
  socketAuthority: PodmanSocketAuthority,
): NativePodmanPreflightReceipt {
  const socketPath = socketAuthority.socketPath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new NativePodmanPreflightError(
      `Podman API socket '${socketPath}' returned unreadable system information.`,
    );
  }
  const host = field(parsed, "host", "Host");
  const security = field(host, "security", "Security");
  const rootless = booleanField(security, "rootless", "Rootless");
  const cgroupVersion = stringField(
    host,
    "cgroupVersion",
    "cgroupsVersion",
    "CgroupVersion",
    "CgroupsVersion",
  ).toLowerCase();
  const hostOs = stringField(host, "os", "OS").toLowerCase();
  const architecture = normalizePodmanArchitecture(stringField(host, "arch", "Arch").toLowerCase());
  const networkBackend = stringField(host, "networkBackend", "NetworkBackend") || "unknown";
  const cdiDevices = new Set<string>();
  collectCdiDevices(host, cdiDevices);

  if (rootless !== true) {
    throw new NativePodmanPreflightError(
      "Native Podman support requires a rootless Podman API service.",
    );
  }
  if (cgroupVersion !== "v2") {
    throw new NativePodmanPreflightError(
      `Native Podman support requires cgroups v2; detected '${cgroupVersion || "unknown"}'.`,
    );
  }
  if (hostOs !== "linux") {
    throw new NativePodmanPreflightError(
      `Native Podman support currently requires Linux; the Podman service reports '${hostOs || "unknown"}'.`,
    );
  }
  if (architecture === null) {
    throw new NativePodmanPreflightError(
      `Native Podman support requires amd64 or arm64; the Podman service reports '${stringField(host, "arch", "Arch") || "unknown"}'.`,
    );
  }

  return {
    driverName: "podman",
    version: "",
    socketPath,
    socketAuthority,
    rootless: true,
    cgroupVersion: "v2",
    os: "linux",
    architecture,
    networkBackend,
    cdiDevices: [...cdiDevices].sort(),
  };
}

function hasSubordinateIdMapping(output: string): boolean {
  return output
    .trim()
    .split(/\r?\n/)
    .some((line) => {
      const values = line.trim().split(/\s+/).map(Number);
      return values.length === 3 && values.every(Number.isFinite) && (values[2] ?? 0) > 1;
    });
}

function assertSubordinateIds(run: NonNullable<NativePodmanPreflightDeps["run"]>): void {
  for (const map of ["uid_map", "gid_map"] as const) {
    const result = run("podman", ["unshare", "cat", `/proc/self/${map}`]);
    if (result.status !== 0 || !hasSubordinateIdMapping(result.stdout)) {
      throw new NativePodmanPreflightError(
        `Rootless Podman requires a subordinate ${map === "uid_map" ? "UID" : "GID"} range for the current user.`,
      );
    }
  }
}

export function assessNativePodman(
  deps: NativePodmanPreflightDeps = {},
): NativePodmanPreflightReceipt {
  const platform = deps.platform ?? process.platform;
  const architecture = deps.architecture ?? process.arch;
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const lstatSync = deps.lstatSync ?? fs.lstatSync;
  const proveSocketAuthority =
    deps.assertSocketAuthority ??
    ((expected: PodmanSocketAuthority) =>
      assertPodmanSocketAuthority(expected, {
        lstat: (filePath) => lstatSync(filePath),
        uid: deps.uid,
      }));

  if (platform !== "linux" || !["x64", "arm64"].includes(architecture)) {
    throw new NativePodmanPreflightError(
      `Native Podman support requires Linux amd64 or arm64; detected ${platform} ${architecture}.`,
    );
  }

  const listenerInspector = run("lsof", ["-v"]);
  if (listenerInspector.status !== 0) {
    throw new NativePodmanPreflightError(
      "Native Podman support requires lsof for complete gateway listener ownership proof. Install lsof and retry.",
    );
  }

  const versionResult = run("podman", ["--version"]);
  const version = dottedVersion(versionResult.stdout)?.join(".") ?? "";
  if (versionResult.status !== 0 || !isPodmanVersionSupported(version)) {
    throw new NativePodmanPreflightError(
      `Native Podman support requires Podman ${MINIMUM_NATIVE_PODMAN_VERSION} or newer; detected '${version || "unavailable"}'.`,
    );
  }

  const explicitSocket = Boolean(env.OPENSHELL_PODMAN_SOCKET?.trim());
  const candidates = nativePodmanSocketCandidates({
    env,
    uid: deps.uid,
    home: deps.home,
  });
  let lastDiagnostic = "";
  for (const socketPath of candidates) {
    assertAbsoluteSocketPath(socketPath, explicitSocket);
    let socketAuthority: PodmanSocketAuthority;
    try {
      socketAuthority = capturePodmanSocketAuthority(socketPath, {
        lstat: (filePath) => lstatSync(filePath),
        uid: deps.uid,
      });
    } catch (error) {
      lastDiagnostic = error instanceof Error ? error.message : String(error);
      continue;
    }
    proveSocketAuthority(socketAuthority);
    const info = run("podman", ["--url", `unix://${socketPath}`, "info", "--format", "json"]);
    proveSocketAuthority(socketAuthority);
    if (info.status !== 0) {
      lastDiagnostic = info.stderr.trim() || `Podman API probe failed for ${socketPath}`;
      continue;
    }
    const receipt = parsePodmanInfo(info.stdout, socketAuthority);
    assertSubordinateIds(run);
    return {
      ...receipt,
      version,
      cdiDevices: unique([...receipt.cdiDevices, ...listNvidiaCdiDevices(run)]).sort(),
    };
  }

  throw new NativePodmanPreflightError(
    `No responsive rootless Podman API socket was found${lastDiagnostic ? ` (${lastDiagnostic})` : ""}. Enable podman.socket or set OPENSHELL_PODMAN_SOCKET.`,
  );
}
