// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import type { RuntimeProviderDoctorCheck } from "./contract";

export const MINIMUM_PODMAN_VERSION = "5.0.0";

export interface PodmanHostPreflightReceipt {
  readonly providerId: "podman";
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly rootless: true;
  readonly cgroupVersion: "v2";
  readonly os: "linux";
  readonly architecture: "amd64" | "arm64";
  readonly networkBackend: string;
}

export interface PodmanHostPreflightOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
}

export class PodmanHostPreflightError extends Error {
  constructor(message: string) {
    super(`Podman preflight failed: ${message}`);
    this.name = "PodmanHostPreflightError";
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function field(value: unknown, ...names: string[]): unknown {
  const source = record(value);
  if (!source) return undefined;
  for (const name of names) {
    if (Object.hasOwn(source, name)) return source[name];
  }
  return undefined;
}

function textField(value: unknown, ...names: string[]): string {
  const candidate = field(value, ...names);
  return typeof candidate === "string" ? candidate.trim() : "";
}

function booleanField(value: unknown, ...names: string[]): boolean | null {
  const candidate = field(value, ...names);
  return typeof candidate === "boolean" ? candidate : null;
}

function dottedVersion(value: string): readonly number[] | null {
  const match = value.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/u);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isPodmanVersionSupported(
  actual: string,
  minimum = MINIMUM_PODMAN_VERSION,
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

function requireSupportedVersion(value: string, subject: "client" | "server"): string {
  const version = dottedVersion(value)?.join(".") ?? "";
  if (!isPodmanVersionSupported(version)) {
    throw new PodmanHostPreflightError(
      `Podman ${MINIMUM_PODMAN_VERSION} or newer is required on the ${subject}; detected '${version || "unavailable"}'`,
    );
  }
  return version;
}

function commandDetail(result: ContainerEngineCommandResult): string {
  return (result.stderr || result.stdout || result.error?.message || "unavailable")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-500);
}

function requireSuccessful(
  operation: string,
  result: ContainerEngineCommandResult,
): ContainerEngineCommandResult {
  if (result.status !== 0 || result.error) {
    throw new PodmanHostPreflightError(`${operation}: ${commandDetail(result)}`);
  }
  return result;
}

function normalizeArchitecture(value: string): "amd64" | "arm64" | null {
  if (value === "amd64" || value === "x86_64") return "amd64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return null;
}

function hasSubordinateIdMapping(output: string): boolean {
  return output
    .trim()
    .split(/\r?\n/u)
    .some((line) => {
      const values = line.trim().split(/\s+/u).map(Number);
      return values.length === 3 && values.every(Number.isFinite) && (values[2] ?? 0) > 1;
    });
}

function requireSubordinateIdMappings(engine: ContainerEngine): void {
  for (const mapping of ["uid_map", "gid_map"] as const) {
    const result = requireSuccessful(
      `${mapping} inspection`,
      engine.captureHost(["unshare", "cat", `/proc/self/${mapping}`], 10_000),
    );
    if (!hasSubordinateIdMapping(result.stdout)) {
      throw new PodmanHostPreflightError(
        `rootless Podman requires a subordinate ${mapping === "uid_map" ? "UID" : "GID"} range for the current user`,
      );
    }
  }
}

export function qualifyPodmanHost(
  engine: ContainerEngine,
  options: PodmanHostPreflightOptions = {},
): PodmanHostPreflightReceipt {
  if (engine.operation !== "host-doctor" || engine.engineId !== "podman") {
    throw new PodmanHostPreflightError("host qualification requires a Podman host-doctor engine");
  }
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== "linux" || !["x64", "arm64"].includes(architecture)) {
    throw new PodmanHostPreflightError(
      `basic native lifecycle requires Linux amd64 or arm64; detected ${platform} ${architecture}`,
    );
  }

  const clientVersionResult = requireSuccessful(
    "client version inspection",
    engine.captureHost(["--version"], 10_000),
  );
  const clientVersion = requireSupportedVersion(clientVersionResult.stdout, "client");

  const serverVersionResult = requireSuccessful(
    "server version inspection",
    engine.capture(["version", "--format", "json"], 10_000),
  );
  let versionInfo: unknown;
  try {
    versionInfo = JSON.parse(serverVersionResult.stdout);
  } catch {
    throw new PodmanHostPreflightError("the Podman API returned unreadable version information");
  }
  const serverVersion = requireSupportedVersion(
    textField(field(versionInfo, "Server", "server"), "Version", "version"),
    "server",
  );

  const infoResult = requireSuccessful(
    "rootless API inspection",
    engine.capture(["info", "--format", "json"], 15_000),
  );
  let info: unknown;
  try {
    info = JSON.parse(infoResult.stdout);
  } catch {
    throw new PodmanHostPreflightError("the Podman API returned unreadable system information");
  }
  const host = field(info, "host", "Host");
  const security = field(host, "security", "Security");
  if (booleanField(security, "rootless", "Rootless") !== true) {
    throw new PodmanHostPreflightError("a rootless Podman API service is required");
  }
  const cgroupVersion = textField(
    host,
    "cgroupVersion",
    "cgroupsVersion",
    "CgroupVersion",
    "CgroupsVersion",
  ).toLowerCase();
  if (cgroupVersion !== "v2") {
    throw new PodmanHostPreflightError(
      `cgroups v2 is required; detected '${cgroupVersion || "unknown"}'`,
    );
  }
  const hostOs = textField(host, "os", "OS").toLowerCase();
  if (hostOs !== "linux") {
    throw new PodmanHostPreflightError(
      `the Podman service must run Linux; detected '${hostOs || "unknown"}'`,
    );
  }
  const reportedArchitecture = textField(host, "arch", "Arch").toLowerCase();
  const normalizedArchitecture = normalizeArchitecture(reportedArchitecture);
  if (!normalizedArchitecture) {
    throw new PodmanHostPreflightError(
      `the Podman service must report amd64 or arm64; detected '${reportedArchitecture || "unknown"}'`,
    );
  }
  const expectedArchitecture = architecture === "x64" ? "amd64" : "arm64";
  if (normalizedArchitecture !== expectedArchitecture) {
    throw new PodmanHostPreflightError(
      `the Podman service architecture '${normalizedArchitecture}' does not match host '${expectedArchitecture}'`,
    );
  }
  requireSubordinateIdMappings(engine);

  return Object.freeze({
    providerId: "podman",
    clientVersion,
    serverVersion,
    rootless: true,
    cgroupVersion: "v2",
    os: "linux",
    architecture: normalizedArchitecture,
    networkBackend: textField(host, "networkBackend", "NetworkBackend") || "unknown",
  });
}

export function inspectPodmanHost(
  engine: ContainerEngine,
  options: PodmanHostPreflightOptions = {},
): RuntimeProviderDoctorCheck {
  try {
    const receipt = qualifyPodmanHost(engine, options);
    return {
      group: "Host",
      label: "Podman runtime",
      status: "ok",
      detail: `rootless server ${receipt.serverVersion} (client ${receipt.clientVersion}), cgroups v2, ${receipt.os}/${receipt.architecture}`,
    };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/gu, " ")
      .trim()
      .slice(-500);
    return {
      group: "Host",
      label: "Podman runtime",
      status: "fail",
      detail,
      hint: "start a rootless Podman 5 API service on Linux and retry",
    };
  }
}
