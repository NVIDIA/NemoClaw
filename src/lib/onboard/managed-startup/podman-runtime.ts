// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const FULL_IMAGE_ID_RE = /^(?:sha256:)?([a-f0-9]{64})$/u;
const PODMAN_PROBE_TIMEOUT_MS = 30_000;

export interface PodmanManagedStartupCommandResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr?: Buffer | string | null;
  readonly stdout?: Buffer | string | null;
}

export type RunManagedStartupPodmanCommand = (
  command: "podman",
  args: readonly string[],
  options: SpawnSyncOptions,
) => PodmanManagedStartupCommandResult;

export interface PodmanManagedStartupRuntimeDeps {
  readonly run?: RunManagedStartupPodmanCommand;
}

export interface PodmanManagedStartupRuntimeIdentity {
  readonly fingerprint: string;
  readonly socketPath: string;
}

export interface PodmanManagedStartupContainerIdentity {
  readonly containerId: string;
  readonly image: string;
  readonly running: boolean;
}

type JsonRecord = Record<string, unknown>;

function output(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function optionalRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be a safe normalized absolute path.`);
  }
  return value;
}

function fullContainerId(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_CONTAINER_ID_RE.test(value)) {
    throw new Error(`${label} must be one full lowercase Podman container ID.`);
  }
  return value;
}

function immutableImage(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a full immutable Podman image ID.`);
  }
  const match = value.match(FULL_IMAGE_ID_RE);
  if (!match?.[1]) {
    throw new Error(`${label} must be a full immutable Podman image ID.`);
  }
  return `sha256:${match[1]}`;
}

export function podmanManagedStartupCommandDetail(
  result: PodmanManagedStartupCommandResult,
  maxLength = 1200,
): string {
  return `${output(result.stderr)} ${output(result.stdout)} ${result.error?.message ?? ""}`
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-maxLength);
}

export function podmanManagedStartupSocketUrl(socketPath: string): string {
  return `unix://${absolutePath(socketPath, "Managed-startup Podman socket path")}`;
}

export function runManagedStartupPodman(
  socketPath: string,
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly timeout?: number;
  },
  deps: PodmanManagedStartupRuntimeDeps,
): PodmanManagedStartupCommandResult {
  const run =
    deps.run ??
    ((command: "podman", commandArgs: readonly string[], spawnOptions: SpawnSyncOptions) =>
      spawnSync(command, [...commandArgs], spawnOptions));
  try {
    return run("podman", ["--url", podmanManagedStartupSocketUrl(socketPath), ...args], {
      encoding: "utf8",
      input: options.input,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: options.timeout ?? PODMAN_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      status: null,
    };
  }
}

function requireZero(
  result: PodmanManagedStartupCommandResult,
  action: string,
): PodmanManagedStartupCommandResult {
  if (result.status === 0) return result;
  const detail = podmanManagedStartupCommandDetail(result);
  throw new Error(
    `${action} failed with non-zero or unavailable Podman status${detail ? `: ${detail}` : "."}`,
  );
}

function parseRootlessRuntimeInfo(
  text: string,
): Omit<PodmanManagedStartupRuntimeIdentity, "socketPath"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Managed-startup Podman API identity proof returned unreadable JSON.");
  }
  const root = record(parsed, "Managed-startup Podman API identity");
  const host = optionalRecord(root.host ?? root.Host);
  const security = optionalRecord(host?.security ?? host?.Security);
  const store = optionalRecord(root.store ?? root.Store);
  const rootless = security?.rootless ?? security?.Rootless;
  const graphRoot = absolutePath(
    store?.graphRoot ?? store?.GraphRoot,
    "Managed-startup Podman graph root",
  );
  const runRoot = absolutePath(store?.runRoot ?? store?.RunRoot, "Managed-startup Podman run root");
  if (rootless !== true) {
    throw new Error("Managed startup requires a rootless Podman API.");
  }
  return {
    fingerprint: createHash("sha256").update(`${graphRoot}\0${runRoot}`).digest("hex"),
  };
}

export function pinPodmanManagedStartupRuntime(
  socketPath: string,
  deps: PodmanManagedStartupRuntimeDeps,
): PodmanManagedStartupRuntimeIdentity {
  const normalizedSocketPath = absolutePath(socketPath, "Managed-startup Podman socket path");
  const result = requireZero(
    runManagedStartupPodman(normalizedSocketPath, ["info", "--format", "json"], {}, deps),
    "Managed-startup rootless Podman API identity proof",
  );
  return Object.freeze({
    ...parseRootlessRuntimeInfo(output(result.stdout)),
    socketPath: normalizedSocketPath,
  });
}

export function assertPodmanManagedStartupRuntime(
  expected: PodmanManagedStartupRuntimeIdentity,
  deps: PodmanManagedStartupRuntimeDeps,
): void {
  const actual = pinPodmanManagedStartupRuntime(expected.socketPath, deps);
  if (actual.fingerprint !== expected.fingerprint) {
    throw new Error("Managed-startup Podman runtime identity changed after it was pinned.");
  }
}

function parseContainerInspect(text: string): PodmanManagedStartupContainerIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Podman returned malformed inspect output for the managed-startup container.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Podman inspect did not resolve exactly one managed-startup container.");
  }
  const inspect = record(parsed[0], "Managed-startup Podman container inspect");
  const state = record(inspect.State, "Managed-startup Podman container State");
  if (typeof state.Running !== "boolean") {
    throw new Error("Managed-startup Podman container State.Running must be a boolean.");
  }
  for (const field of ["Paused", "Restarting", "Dead"] as const) {
    if (state[field] !== undefined && typeof state[field] !== "boolean") {
      throw new Error(`Managed-startup Podman container State.${field} must be a boolean.`);
    }
  }
  if (
    state.Running === true &&
    (state.Paused === true || state.Restarting === true || state.Dead === true)
  ) {
    throw new Error("Managed-startup Podman container is not stably running.");
  }
  return {
    containerId: fullContainerId(inspect.Id, "Managed-startup Podman inspect Id"),
    image: immutableImage(inspect.Image, "Managed-startup Podman inspect Image"),
    running: state.Running,
  };
}

export function inspectExactPodmanManagedStartupContainer(
  runtime: PodmanManagedStartupRuntimeIdentity,
  expected: {
    readonly containerId: string;
    readonly image?: string;
    readonly requireRunning?: boolean;
  },
  deps: PodmanManagedStartupRuntimeDeps,
): PodmanManagedStartupContainerIdentity {
  const containerId = fullContainerId(expected.containerId, "Managed-startup Podman container ID");
  const result = requireZero(
    runManagedStartupPodman(runtime.socketPath, ["container", "inspect", containerId], {}, deps),
    "Managed-startup Podman container inspect",
  );
  const actual = parseContainerInspect(output(result.stdout));
  if (actual.containerId !== containerId) {
    throw new Error("Managed-startup Podman container identity changed after it was pinned.");
  }
  if (
    expected.image !== undefined &&
    actual.image !== immutableImage(expected.image, "Pinned image")
  ) {
    throw new Error("Managed-startup Podman image identity changed after it was pinned.");
  }
  if (expected.requireRunning === true && !actual.running) {
    throw new Error("Managed-startup Podman container is not running.");
  }
  return actual;
}
