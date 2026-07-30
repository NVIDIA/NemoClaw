// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { openshellSandboxCommandEnvValue } from "../../docker-startup-command-env";
import type { PodmanGpuAttachment } from "./gpu-attachment";

// Exact OpenShell v0.0.85 Podman identity contract. Later driver schemas must
// register a new adapter; discovery deliberately fails closed on label or name
// drift instead of guessing which container NemoClaw is allowed to replace.
export const PODMAN_MANAGED_LABEL = "openshell.managed";
export const PODMAN_SANDBOX_ID_LABEL = "openshell.sandbox-id";
export const PODMAN_SANDBOX_NAME_LABEL = "openshell.sandbox-name";
export const PODMAN_SANDBOX_NAMESPACE_LABEL = "openshell.sandbox-namespace";
export const PODMAN_SANDBOX_CONTAINER_PREFIX = "openshell-sandbox-";

const COMMAND_ENV = "OPENSHELL_SANDBOX_COMMAND";
const TOKEN_FILE_ENV = "OPENSHELL_SANDBOX_TOKEN_FILE";
const TLS_ENV_KEYS = ["OPENSHELL_TLS_CA", "OPENSHELL_TLS_CERT", "OPENSHELL_TLS_KEY"] as const;
const WORKSPACE_DESTINATION = "/sandbox";
const SUPERVISOR_DESTINATION = "/opt/openshell/bin";
const NETNS_TMPFS_DESTINATION = "/run/netns";
const FULL_ID_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/iu;
const SAFE_CAPABILITY_PATTERN = /^(?:CAP_)?[A-Z][A-Z0-9_]*$/u;
const SAFE_ULIMIT_PATTERN = /^(?:RLIMIT_)?[A-Za-z][A-Za-z0-9_]*$/u;

type JsonRecord = Record<string, unknown>;

export interface PodmanUlimit {
  readonly hard: number;
  readonly name: string;
  readonly soft: number;
}

export interface PodmanManagedSandboxInspect {
  readonly raw: JsonRecord;
  readonly containerId: string;
  readonly immutableImage: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly running: boolean;
  readonly sandboxId: string;
}

export interface PodmanManagedSandboxCreatePlan {
  readonly args: readonly string[];
  readonly environmentInput: string;
  readonly immutableImage: string;
}

export type PodmanSandboxIdentityMode = "managed" | "watcher-invisible-backup";

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

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a safe${allowEmpty ? "" : " non-empty"} string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string {
  if (value === undefined || value === null || value === "") return "";
  return string(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  return array(value, label).map((entry, index) => string(entry, `${label}[${index}]`, true));
}

function boolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  options: { fallback?: number; minimum?: number; maximum?: number } = {},
): number {
  if (value === undefined || value === null) return options.fallback ?? 0;
  if (
    !Number.isSafeInteger(value) ||
    (options.minimum !== undefined && (value as number) < options.minimum) ||
    (options.maximum !== undefined && (value as number) > options.maximum)
  ) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return value as number;
}

function hasEntries(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false || value === 0) {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as JsonRecord).length > 0;
  return true;
}

function assertEmpty(value: unknown, label: string): void {
  if (hasEntries(value)) {
    throw new Error(`${label} cannot be reproduced faithfully by native Podman recreation.`);
  }
}

function fullId(value: unknown, label: string): string {
  const candidate = string(value, label);
  const match = candidate.match(FULL_ID_PATTERN);
  if (!match?.[1]) throw new Error(`${label} must be a full immutable SHA-256 identifier.`);
  return match[1].toLowerCase();
}

function immutableImage(value: unknown, label: string): string {
  return `sha256:${fullId(value, label)}`;
}

function safeDelimitedValue(value: unknown, label: string): string {
  const candidate = string(value, label);
  if (/[\r\n,]/u.test(candidate)) {
    throw new Error(`${label} contains a delimiter Podman recreation cannot preserve safely.`);
  }
  return candidate;
}

function safeLabelValue(value: unknown, label: string): string {
  const candidate = string(value, label, true);
  if (/[\r\n,]/u.test(candidate)) {
    throw new Error(`${label} contains a delimiter Podman recreation cannot preserve safely.`);
  }
  return candidate;
}

function absoluteContainerPath(value: unknown, label: string): string {
  const candidate = safeDelimitedValue(value, label);
  if (!candidate.startsWith("/") || candidate.includes("/../") || candidate.endsWith("/..")) {
    throw new Error(`${label} must be an absolute normalized container path.`);
  }
  return candidate;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const source = record(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    result[string(key, `${label} key`)] = string(entry, `${label}.${key}`, true);
  }
  return result;
}

const PODMAN_OPEN_SHELL_IDENTITY_LABELS = new Set([
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
]);

function sandboxLabels(
  config: JsonRecord,
  expected: {
    readonly identityMode?: PodmanSandboxIdentityMode;
    readonly sandboxId?: string;
    readonly sandboxName: string;
  },
): { labels: Record<string, string>; sandboxId: string } {
  const labels = stringMap(config.Labels, "Podman inspect Config.Labels");
  if (expected.identityMode === "watcher-invisible-backup") {
    const leakedIdentity = [...PODMAN_OPEN_SHELL_IDENTITY_LABELS].filter((label) =>
      Object.hasOwn(labels, label),
    );
    if (leakedIdentity.length > 0) {
      throw new Error(
        `Podman rollback backup remains visible to the OpenShell watcher through label(s): ${leakedIdentity.join(", ")}.`,
      );
    }
    const sandboxId = string(expected.sandboxId, "Expected Podman rollback backup sandbox ID");
    return { labels, sandboxId };
  }
  if (labels[PODMAN_MANAGED_LABEL] !== "true") {
    throw new Error(`Podman sandbox is missing exact label ${PODMAN_MANAGED_LABEL}=true.`);
  }
  if (labels[PODMAN_SANDBOX_NAME_LABEL] !== expected.sandboxName) {
    throw new Error(
      `Podman sandbox is missing exact label ${PODMAN_SANDBOX_NAME_LABEL}=${expected.sandboxName}.`,
    );
  }
  if (!Object.hasOwn(labels, PODMAN_SANDBOX_ID_LABEL)) {
    throw new Error(`Podman sandbox is missing exact label ${PODMAN_SANDBOX_ID_LABEL}.`);
  }
  string(labels[PODMAN_SANDBOX_ID_LABEL], `Podman label ${PODMAN_SANDBOX_ID_LABEL}`);
  if (!Object.hasOwn(labels, PODMAN_SANDBOX_NAMESPACE_LABEL)) {
    throw new Error(`Podman sandbox is missing exact label ${PODMAN_SANDBOX_NAMESPACE_LABEL}.`);
  }
  return {
    labels,
    sandboxId: labels[PODMAN_SANDBOX_ID_LABEL] as string,
  };
}

export function parsePodmanManagedSandboxInspect(
  output: string,
  expected: {
    readonly containerId: string;
    readonly identityMode?: PodmanSandboxIdentityMode;
    readonly name: string;
    readonly requireRunning?: boolean;
    readonly sandboxId?: string;
    readonly sandboxName: string;
  },
): PodmanManagedSandboxInspect {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Podman container inspect returned unreadable JSON.");
  }
  const entries = array(parsed, "Podman container inspect response");
  if (entries.length !== 1) {
    throw new Error("Podman container inspect must identify exactly one container.");
  }
  const raw = record(entries[0], "Podman container inspect entry");
  const containerId = fullId(raw.Id, "Podman inspect Id");
  if (containerId !== fullId(expected.containerId, "Expected Podman container ID")) {
    throw new Error("Podman managed sandbox identity changed after it was pinned.");
  }
  const name = string(raw.Name, "Podman inspect Name");
  if (name !== expected.name) {
    throw new Error(`Podman managed sandbox name changed from '${expected.name}' to '${name}'.`);
  }
  const config = record(raw.Config, "Podman inspect Config");
  const { labels, sandboxId } = sandboxLabels(config, expected);
  const state = record(raw.State, "Podman inspect State");
  const running = boolean(state.Running, "Podman inspect State.Running");
  if (expected.requireRunning && !running) {
    throw new Error("Podman managed sandbox must be running before recreation.");
  }
  return {
    raw,
    containerId,
    immutableImage: immutableImage(raw.Image, "Podman inspect Image"),
    labels,
    name,
    running,
    sandboxId,
  };
}

function environment(
  config: JsonRecord,
  command: readonly string[] | null,
  requireCommandEnvironment: boolean,
): string[] {
  const commandValue = command === null ? null : openshellSandboxCommandEnvValue(command);
  if (command !== null && !commandValue) {
    throw new Error("Podman sandbox startup command must not be empty.");
  }
  const values = stringArray(config.Env, "Podman inspect Config.Env");
  const byKey = new Map<string, string>();
  for (const entry of values) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("Podman inspect environment contains a malformed entry.");
    const key = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || byKey.has(key)) {
      throw new Error(`Podman inspect environment key '${key}' is invalid or duplicated.`);
    }
    if (entry.endsWith("=*******")) {
      throw new Error("Podman env-type secrets cannot be reproduced from redacted inspect data.");
    }
    byKey.set(key, entry.slice(separator + 1));
  }
  if (command === null) {
    const preserved = byKey.get(COMMAND_ENV);
    if (!preserved || preserved !== openshellSandboxCommandEnvValue(preserved.split(" "))) {
      throw new Error(
        `Podman rollback backup cannot preserve a non-canonical ${COMMAND_ENV} value.`,
      );
    }
  } else if (requireCommandEnvironment && byKey.get(COMMAND_ENV) !== commandValue) {
    throw new Error(
      `Podman replacement environment does not preserve the requested ${COMMAND_ENV} value.`,
    );
  }
  if (commandValue !== null) byKey.set(COMMAND_ENV, commandValue);
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

function environmentFileInput(env: readonly string[]): string {
  for (const entry of env) {
    if (/[\r\n]/u.test(entry)) {
      throw new Error(
        "Podman inspect environment contains a multiline value that cannot be passed without leaking it in process arguments.",
      );
    }
  }
  return `${env.join("\n")}\n`;
}

function envValue(env: readonly string[], key: string): string | null {
  const prefix = `${key}=`;
  const entry = env.find((candidate) => candidate.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

function mountOptionList(mount: JsonRecord, label: string): string[] {
  return stringArray(mount.Options, `${label}.Options`);
}

function mountValue(
  mount: JsonRecord,
  imagePins: Readonly<Record<string, string>>,
  index: number,
): string {
  const label = `Podman inspect Mounts[${index}]`;
  const type = string(mount.Type, `${label}.Type`).toLowerCase();
  const destination = absoluteContainerPath(mount.Destination, `${label}.Destination`);
  const readWrite = boolean(mount.RW, `${label}.RW`);
  const subpath = optionalString(mount.SubPath, `${label}.SubPath`);
  const options = mountOptionList(mount, label);
  const result = [`type=${type}`];

  if (type === "volume") {
    const name = safeDelimitedValue(mount.Name, `${label}.Name`);
    const driver = optionalString(mount.Driver, `${label}.Driver`);
    if (driver && driver !== "local") {
      throw new Error(`${label} uses unsupported volume driver '${driver}'.`);
    }
    if (options.length > 0) {
      throw new Error(`${label} has volume options that cannot be reproduced faithfully.`);
    }
    result.push(`source=${name}`, `destination=${destination}`, `ro=${String(!readWrite)}`);
  } else if (type === "bind") {
    const source = safeDelimitedValue(mount.Source, `${label}.Source`);
    if (!source.startsWith("/")) throw new Error(`${label}.Source must be an absolute host path.`);
    const unsupported = options.filter((option) => option !== "rbind");
    if (unsupported.length > 0) {
      throw new Error(`${label} has unsupported bind options: ${unsupported.join(", ")}.`);
    }
    result.push(`source=${source}`, `destination=${destination}`, `ro=${String(!readWrite)}`);
    const propagation = optionalString(mount.Propagation, `${label}.Propagation`);
    if (propagation) result.push(`bind-propagation=${propagation}`);
    const mode = optionalString(mount.Mode, `${label}.Mode`);
    if (mode === "z") result.push("relabel=shared");
    else if (mode === "Z") result.push("relabel=private");
    else if (mode) throw new Error(`${label} has unsupported SELinux mode '${mode}'.`);
  } else if (type === "image") {
    const source = safeDelimitedValue(mount.Source, `${label}.Source`);
    const pinned = imagePins[source];
    if (!pinned)
      throw new Error(`${label} image source '${source}' was not pinned before mutation.`);
    if (options.length > 0) {
      throw new Error(`${label} has image options that cannot be reproduced faithfully.`);
    }
    result.push(
      `source=${immutableImage(pinned, `${label} pinned image`)}`,
      `destination=${destination}`,
      `rw=${String(readWrite)}`,
    );
  } else {
    throw new Error(`${label} uses unsupported mount type '${type}'.`);
  }

  if (subpath) result.push(`subpath=${safeDelimitedValue(subpath, `${label}.SubPath`)}`);
  return result.join(",");
}

function assertRequiredMounts(
  mounts: readonly JsonRecord[],
  env: readonly string[],
  sandboxId: string,
): void {
  const workspace = mounts.filter(
    (mount) =>
      String(mount.Type).toLowerCase() === "volume" &&
      mount.Name === `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxId}-workspace` &&
      mount.Destination === WORKSPACE_DESTINATION &&
      mount.RW === true,
  );
  if (workspace.length !== 1) {
    throw new Error("Podman recreation requires exactly one writable /sandbox workspace volume.");
  }
  const supervisor = mounts.filter(
    (mount) =>
      String(mount.Type).toLowerCase() === "image" &&
      mount.Destination === SUPERVISOR_DESTINATION &&
      mount.RW === false,
  );
  if (supervisor.length !== 1) {
    throw new Error(
      "Podman recreation requires exactly one read-only supervisor image mount at /opt/openshell/bin.",
    );
  }

  const tlsPaths = TLS_ENV_KEYS.map((key) => envValue(env, key));
  if (tlsPaths.some(Boolean) && !tlsPaths.every(Boolean)) {
    throw new Error("Podman recreation requires all three OpenShell TLS path variables together.");
  }
  for (const [index, target] of tlsPaths.entries()) {
    if (!target) continue;
    const normalized = absoluteContainerPath(target, TLS_ENV_KEYS[index] ?? "OpenShell TLS path");
    const matches = mounts.filter(
      (mount) =>
        String(mount.Type).toLowerCase() === "bind" &&
        mount.Destination === normalized &&
        mount.RW === false,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Podman recreation cannot prove the read-only TLS mount for '${normalized}'.`,
      );
    }
  }
}

export function podmanImageMountSources(inspect: PodmanManagedSandboxInspect): string[] {
  const mounts = array(inspect.raw.Mounts, "Podman inspect Mounts").map((entry, index) =>
    record(entry, `Podman inspect Mounts[${index}]`),
  );
  return [
    ...new Set(
      mounts
        .filter((mount) => String(mount.Type).toLowerCase() === "image")
        .map((mount, index) =>
          safeDelimitedValue(mount.Source, `Podman inspect image Mounts[${index}].Source`),
        ),
    ),
  ].sort();
}

function secretArguments(config: JsonRecord, env: readonly string[], sandboxId: string): string[] {
  const secrets = (
    config.Secrets === undefined || config.Secrets === null
      ? []
      : array(config.Secrets, "Podman inspect Config.Secrets")
  ).map((entry, index) => record(entry, `Podman inspect Config.Secrets[${index}]`));
  const cmd = stringArray(config.Cmd, "Podman inspect Config.Cmd");
  const tokenTarget = envValue(env, TOKEN_FILE_ENV);
  const argumentTarget = (flag: string): string | null => {
    const index = cmd.indexOf(flag);
    if (index === -1) return null;
    if (cmd.indexOf(flag, index + 1) !== -1) {
      throw new Error(`Podman inspect command repeats reserved supervisor flag '${flag}'.`);
    }
    return cmd[index + 1] ?? null;
  };
  const targets = new Map<string, string | null>([
    ["openshell-token-", tokenTarget],
    ["openshell-proxy-auth-", argumentTarget("--upstream-proxy-auth-file")],
    ["openshell-trusted-init-", argumentTarget("--trusted-init-file")],
  ]);
  const args: string[] = [];
  const seenTargets = new Set<string>();
  for (const [index, secret] of secrets.entries()) {
    const label = `Podman inspect Config.Secrets[${index}]`;
    const name = safeDelimitedValue(secret.Name, `${label}.Name`);
    const secretId = fullId(secret.ID, `${label}.ID`);
    const matchingPrefix = [...targets.keys()].find((prefix) => name.startsWith(prefix));
    if (!matchingPrefix) {
      throw new Error(`${label} '${name}' has no deterministic OpenShell target mapping.`);
    }
    if (matchingPrefix === "openshell-token-" && name !== `openshell-token-${sandboxId}`) {
      throw new Error(`${label} '${name}' does not match the exact OpenShell sandbox ID.`);
    }
    const targetValue = targets.get(matchingPrefix);
    if (!targetValue) {
      throw new Error(`${label} '${name}' is not paired with its required path evidence.`);
    }
    const target = absoluteContainerPath(targetValue, `${label} target`);
    if (seenTargets.has(target)) throw new Error(`Podman secrets duplicate target '${target}'.`);
    seenTargets.add(target);
    const uid = safeInteger(secret.UID, `${label}.UID`, { minimum: 0 });
    const gid = safeInteger(secret.GID, `${label}.GID`, { minimum: 0 });
    const mode = safeInteger(secret.Mode, `${label}.Mode`, { minimum: 0, maximum: 0o7777 });
    args.push(
      "--secret",
      `${secretId},type=mount,target=${target},uid=${uid},gid=${gid},mode=${mode
        .toString(8)
        .padStart(4, "0")}`,
    );
  }
  if (
    tokenTarget &&
    !secrets.some((secret) => String(secret.Name).startsWith("openshell-token-"))
  ) {
    throw new Error("Podman token-file environment is missing its OpenShell token secret.");
  }
  return args;
}

function tmpfsArguments(hostConfig: JsonRecord): string[] {
  const tmpfs = record(hostConfig.Tmpfs, "Podman inspect HostConfig.Tmpfs");
  if (!Object.hasOwn(tmpfs, NETNS_TMPFS_DESTINATION)) {
    throw new Error("Podman recreation requires the OpenShell /run/netns tmpfs mount.");
  }
  const args: string[] = [];
  for (const [targetValue, optionValue] of Object.entries(tmpfs).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const target = absoluteContainerPath(targetValue, "Podman tmpfs target");
    const options = optionalString(optionValue, `Podman tmpfs options for ${target}`);
    if (
      options &&
      options
        .split(",")
        .some(
          (option) =>
            !/^(?:rw|ro|nosuid|nodev|noexec|exec|size=\d+|mode=[0-7]{3,4}|noatime|notmpcopyup)$/u.test(
              option,
            ),
        )
    ) {
      throw new Error(`Podman tmpfs '${target}' has options that cannot be reproduced faithfully.`);
    }
    args.push("--tmpfs", options ? `${target}:${options}` : target);
  }
  return args;
}

function healthArguments(config: JsonRecord): string[] {
  const health = record(config.Healthcheck, "Podman inspect Config.Healthcheck");
  const test = stringArray(health.Test, "Podman inspect Config.Healthcheck.Test");
  if (test.length < 2 || !["CMD", "CMD-SHELL"].includes(test[0] ?? "")) {
    throw new Error("Podman recreation requires an explicit exec or shell healthcheck.");
  }
  if (config.StartupHealthCheck !== undefined && config.StartupHealthCheck !== null) {
    throw new Error("Podman startup healthchecks are not yet reproducible by this primitive.");
  }
  const args = ["--health-cmd", JSON.stringify(test)];
  const durationFlags = [
    ["Interval", "--health-interval"],
    ["Timeout", "--health-timeout"],
    ["StartPeriod", "--health-start-period"],
  ] as const;
  for (const [field, flag] of durationFlags) {
    const duration = safeInteger(health[field], `Podman healthcheck ${field}`, { minimum: 0 });
    args.push(flag, `${duration}ns`);
  }
  args.push(
    "--health-retries",
    String(safeInteger(health.Retries, "Podman healthcheck Retries", { minimum: 0 })),
  );
  const action = optionalString(config.HealthcheckOnFailureAction, "HealthcheckOnFailureAction");
  if (action && action !== "none") args.push("--health-on-failure", action);
  const destination = optionalString(config.HealthLogDestination, "HealthLogDestination");
  if (destination) args.push("--health-log-destination", destination);
  const maxCount = safeInteger(config.HealthcheckMaxLogCount, "HealthcheckMaxLogCount", {
    minimum: 0,
  });
  if (maxCount > 0) args.push("--health-max-log-count", String(maxCount));
  const maxSize = safeInteger(config.HealthcheckMaxLogSize, "HealthcheckMaxLogSize", {
    minimum: 0,
  });
  if (maxSize > 0) args.push("--health-max-log-size", String(maxSize));
  return args;
}

function normalizedUlimit(value: PodmanUlimit, label: string): PodmanUlimit {
  let name = string(value.name, `${label}.name`);
  if (!SAFE_ULIMIT_PATTERN.test(name)) throw new Error(`${label}.name '${name}' is invalid.`);
  name = name.replace(/^RLIMIT_/iu, "").toLowerCase();
  const soft = safeInteger(value.soft, `${label}.soft`, { minimum: -1 });
  const hard = safeInteger(value.hard, `${label}.hard`, { minimum: -1 });
  if (hard !== -1 && (soft === -1 || soft > hard)) {
    throw new Error(`${label} has a soft limit greater than its hard limit.`);
  }
  return { name, soft, hard };
}

function ulimitArguments(hostConfig: JsonRecord, required: readonly PodmanUlimit[]): string[] {
  const merged = new Map<string, PodmanUlimit>();
  const existing = hostConfig.Ulimits ?? [];
  for (const [index, entry] of array(existing, "Podman inspect HostConfig.Ulimits").entries()) {
    const source = record(entry, `Podman inspect HostConfig.Ulimits[${index}]`);
    const normalized = normalizedUlimit(
      {
        name: string(source.Name, `HostConfig.Ulimits[${index}].Name`),
        soft: safeInteger(source.Soft, `HostConfig.Ulimits[${index}].Soft`, { minimum: -1 }),
        hard: safeInteger(source.Hard, `HostConfig.Ulimits[${index}].Hard`, { minimum: -1 }),
      },
      `HostConfig.Ulimits[${index}]`,
    );
    if (merged.has(normalized.name)) throw new Error(`Podman ulimit '${normalized.name}' repeats.`);
    merged.set(normalized.name, normalized);
  }
  for (const [index, entry] of required.entries()) {
    const normalized = normalizedUlimit(entry, `Required Podman ulimit[${index}]`);
    merged.set(normalized.name, normalized);
  }
  return [...merged.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((limit) => ["--ulimit", `${limit.name}=${String(limit.soft)}:${String(limit.hard)}`]);
}

function resourceArguments(hostConfig: JsonRecord): string[] {
  const args: string[] = [];
  const numericFlags = [
    ["CpuShares", "--cpu-shares", 0],
    ["CpuPeriod", "--cpu-period", 0],
    ["CpuQuota", "--cpu-quota", -1],
    ["Memory", "--memory", 0],
    ["MemoryReservation", "--memory-reservation", 0],
    ["MemorySwap", "--memory-swap", -1],
    ["PidsLimit", "--pids-limit", -1],
    ["ShmSize", "--shm-size", 0],
  ] as const;
  for (const [field, flag, minimum] of numericFlags) {
    const value = safeInteger(hostConfig[field], `Podman HostConfig.${field}`, { minimum });
    if (value !== 0) args.push(flag, String(value));
  }
  const cpuQuota = safeInteger(hostConfig.CpuQuota, "Podman HostConfig.CpuQuota", { minimum: -1 });
  const cpuPeriod = safeInteger(hostConfig.CpuPeriod, "Podman HostConfig.CpuPeriod", {
    minimum: 0,
  });
  const nanoCpus = safeInteger(hostConfig.NanoCpus, "Podman HostConfig.NanoCpus", {
    minimum: 0,
  });
  if (nanoCpus > 0 && !(cpuQuota > 0 && cpuPeriod > 0)) {
    args.push("--cpus", String(nanoCpus / 1_000_000_000));
  }
  for (const [field, flag] of [
    ["CpusetCpus", "--cpuset-cpus"],
    ["CpusetMems", "--cpuset-mems"],
  ] as const) {
    const value = optionalString(hostConfig[field], `Podman HostConfig.${field}`);
    if (value) {
      if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(value)) {
        throw new Error(`Podman HostConfig.${field} is malformed.`);
      }
      args.push(flag, value);
    }
  }
  if (hostConfig.MemorySwappiness !== undefined && hostConfig.MemorySwappiness !== null) {
    const swappiness = safeInteger(
      hostConfig.MemorySwappiness,
      "Podman HostConfig.MemorySwappiness",
      {
        minimum: -1,
        maximum: 100,
      },
    );
    if (swappiness !== -1 && swappiness !== 0) {
      throw new Error(
        "Podman non-neutral memory swappiness cannot be preserved on the required rootless v2 path.",
      );
    }
  }
  if (boolean(hostConfig.OomKillDisable, "Podman HostConfig.OomKillDisable")) {
    args.push("--oom-kill-disable");
  }
  const oomScore = safeInteger(hostConfig.OomScoreAdj, "Podman HostConfig.OomScoreAdj", {
    minimum: -1000,
    maximum: 1000,
  });
  if (oomScore !== 0) args.push("--oom-score-adj", String(oomScore));
  return args;
}

function capabilityAndSecurityArguments(
  hostConfig: JsonRecord,
  gpuAttachment: PodmanGpuAttachment | null,
): string[] {
  if (boolean(hostConfig.Privileged, "Podman HostConfig.Privileged")) {
    throw new Error("Privileged OpenShell containers are not eligible for managed recreation.");
  }
  const args: string[] = [];
  for (const [field, flag] of [
    ["CapDrop", "--cap-drop"],
    ["CapAdd", "--cap-add"],
  ] as const) {
    const seen = new Set<string>();
    for (const capability of stringArray(hostConfig[field], `Podman HostConfig.${field}`)) {
      if (!SAFE_CAPABILITY_PATTERN.test(capability) || seen.has(capability)) {
        throw new Error(`Podman HostConfig.${field} contains an invalid or duplicate capability.`);
      }
      seen.add(capability);
      args.push(flag, capability);
    }
  }
  const securityOptions = stringArray(hostConfig.SecurityOpt, "Podman HostConfig.SecurityOpt");
  for (const option of securityOptions) {
    args.push("--security-opt", option);
  }
  if (gpuAttachment && !securityOptions.includes("label=disable")) {
    args.push("--security-opt", "label=disable");
  }
  if (boolean(hostConfig.ReadonlyRootfs, "Podman HostConfig.ReadonlyRootfs")) {
    args.push("--read-only");
  }
  return args;
}

function gpuDeviceArguments(
  hostConfig: JsonRecord,
  gpuAttachment: PodmanGpuAttachment | null,
): string[] {
  if (!gpuAttachment) {
    assertEmpty(hostConfig.Devices, "Podman devices");
    return [];
  }
  const devices = array(hostConfig.Devices ?? [], "Podman inspect HostConfig.Devices");
  for (const [index, value] of devices.entries()) {
    const device = record(value, `Podman inspect HostConfig.Devices[${index}]`);
    for (const [fieldName, fieldValue] of [
      ["PathOnHost", device.PathOnHost],
      ["PathInContainer", device.PathInContainer],
    ] as const) {
      const devicePath = absoluteContainerPath(
        fieldValue,
        `Podman inspect HostConfig.Devices[${index}].${fieldName}`,
      );
      if (!devicePath.startsWith("/dev/")) {
        throw new Error(
          `Podman CDI recreation refuses device '${devicePath}' outside the container device tree.`,
        );
      }
    }
  }
  return ["--device", gpuAttachment.device];
}

function networkAndPortArguments(raw: JsonRecord, hostConfig: JsonRecord): string[] {
  const networkSettings = record(raw.NetworkSettings, "Podman inspect NetworkSettings");
  const networks = record(networkSettings.Networks, "Podman inspect NetworkSettings.Networks");
  const names = Object.keys(networks);
  if (names.length !== 1) {
    throw new Error("Podman recreation requires exactly one attached named network.");
  }
  const networkName = safeDelimitedValue(names[0], "Podman network name");
  const mode = optionalString(hostConfig.NetworkMode, "Podman HostConfig.NetworkMode");
  if (mode && !["bridge", "default", networkName].includes(mode)) {
    throw new Error(`Podman network mode '${mode}' cannot be reproduced faithfully.`);
  }
  const network = record(networks[networkName], `Podman network '${networkName}'`);
  const networkId = fullId(network.NetworkID, `Podman network '${networkName}' ID`);
  assertEmpty(network.DriverOpts, `Podman network '${networkName}' driver options`);
  assertEmpty(network.IPAMConfig, `Podman network '${networkName}' IPAM options`);
  assertEmpty(network.Links, `Podman network '${networkName}' links`);
  const args = ["--network", networkId];

  const originalId = fullId(raw.Id, "Podman inspect Id");
  const originalName = string(raw.Name, "Podman inspect Name");
  const automaticAliases = new Set([originalId, originalId.slice(0, 12), originalName]);
  for (const alias of stringArray(network.Aliases, `Podman network '${networkName}' aliases`)) {
    if (!automaticAliases.has(alias)) args.push("--network-alias", alias);
  }

  const configured = optionalRecord(hostConfig.PortBindings) ?? {};
  const actual = optionalRecord(networkSettings.Ports) ?? {};
  for (const [portKey, bindingsValue] of Object.entries(configured).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const match = portKey.match(/^([1-9]\d{0,4})\/(tcp|udp|sctp)$/u);
    const containerPort = Number(match?.[1] ?? 0);
    if (!match || containerPort > 65_535) {
      throw new Error(`Podman port binding '${portKey}' is malformed.`);
    }
    const configuredBindings = array(bindingsValue, `Podman HostConfig.PortBindings.${portKey}`);
    const actualBindings = array(actual[portKey], `Podman NetworkSettings.Ports.${portKey}`);
    if (configuredBindings.length !== actualBindings.length || actualBindings.length === 0) {
      throw new Error(`Podman port binding '${portKey}' lacks exact running-port evidence.`);
    }
    for (const [index, bindingValue] of actualBindings.entries()) {
      const binding = record(bindingValue, `Podman actual port ${portKey}[${index}]`);
      const hostPort = safeInteger(
        Number(string(binding.HostPort, `Podman actual port ${portKey}[${index}].HostPort`)),
        `Podman actual port ${portKey}[${index}].HostPort`,
        { minimum: 1, maximum: 65_535 },
      );
      const hostIp = optionalString(binding.HostIp ?? binding.HostIP, "Podman actual host IP");
      if (hostIp && /[\r\n,]/u.test(hostIp)) throw new Error("Podman host IP is malformed.");
      args.push(
        "--publish",
        `${hostIp ? `${hostIp}:` : ""}${hostPort}:${containerPort}/${match[2]}`,
      );
    }
  }
  if (Object.keys(actual).some((key) => !Object.hasOwn(configured, key))) {
    throw new Error("Podman running port data contains an unconfigured published port.");
  }
  return args;
}

function hostArguments(config: JsonRecord, hostConfig: JsonRecord): string[] {
  const args: string[] = [];
  const hostname = optionalString(config.Hostname, "Podman Config.Hostname");
  if (hostname) args.push("--hostname", hostname);
  const user = optionalString(config.User, "Podman Config.User");
  if (user) args.push("--user", user);
  const workdir = optionalString(config.WorkingDir, "Podman Config.WorkingDir");
  if (workdir) args.push("--workdir", absoluteContainerPath(workdir, "Podman working directory"));
  if (boolean(config.Tty, "Podman Config.Tty")) args.push("--tty");
  if (boolean(config.OpenStdin, "Podman Config.OpenStdin")) args.push("--interactive");
  const stopSignal = optionalString(config.StopSignal, "Podman Config.StopSignal");
  if (stopSignal) args.push("--stop-signal", stopSignal);
  const stopTimeout = safeInteger(config.StopTimeout, "Podman Config.StopTimeout", { minimum: 0 });
  args.push("--stop-timeout", String(stopTimeout));
  const umask = optionalString(config.Umask, "Podman Config.Umask");
  if (umask) {
    if (!/^[0-7]{4}$/u.test(umask)) throw new Error("Podman Config.Umask is malformed.");
    args.push("--umask", umask);
  }
  for (const host of stringArray(hostConfig.ExtraHosts, "Podman HostConfig.ExtraHosts")) {
    args.push("--add-host", host);
  }
  for (const group of stringArray(hostConfig.GroupAdd, "Podman HostConfig.GroupAdd")) {
    args.push("--group-add", group);
  }
  for (const dns of stringArray(hostConfig.Dns, "Podman HostConfig.Dns")) {
    args.push("--dns", dns);
  }
  for (const option of stringArray(hostConfig.DnsOptions, "Podman HostConfig.DnsOptions")) {
    args.push("--dns-option", option);
  }
  for (const search of stringArray(hostConfig.DnsSearch, "Podman HostConfig.DnsSearch")) {
    args.push("--dns-search", search);
  }
  const restart = optionalRecord(hostConfig.RestartPolicy);
  if (restart) {
    const name = optionalString(restart.Name, "Podman RestartPolicy.Name") || "no";
    const retries = safeInteger(restart.MaximumRetryCount, "Podman restart retries", {
      minimum: 0,
    });
    const value = name === "on-failure" && retries > 0 ? `${name}:${retries}` : name;
    if (!["no", "always", "unless-stopped", "on-failure"].includes(name)) {
      throw new Error(`Podman restart policy '${name}' is unsupported.`);
    }
    args.push("--restart", value);
  }
  if (boolean(hostConfig.Init, "Podman HostConfig.Init")) args.push("--init");
  return args;
}

function assertSupportedShape(
  raw: JsonRecord,
  config: JsonRecord,
  hostConfig: JsonRecord,
  gpuAttachment: PodmanGpuAttachment | null,
): void {
  assertEmpty(raw.Pod, "Podman pod membership");
  assertEmpty(raw.Dependencies, "Podman container dependencies");
  if (boolean(raw.IsInfra, "Podman IsInfra") || boolean(raw.IsService, "Podman IsService")) {
    throw new Error("Podman infra and service containers are not eligible for recreation.");
  }
  for (const [field, label] of [
    ["VolumesFrom", "volumes-from"],
    ["CgroupConf", "cgroup v2 settings"],
    ["BlkioWeight", "block IO weight"],
    ["BlkioWeightDevice", "block IO weight devices"],
    ["BlkioDeviceReadBps", "block IO read limits"],
    ["BlkioDeviceWriteBps", "block IO write limits"],
    ["BlkioDeviceReadIOps", "block IO read IOPS"],
    ["BlkioDeviceWriteIOps", "block IO write IOPS"],
    ["CpuRealtimePeriod", "realtime CPU period"],
    ["CpuRealtimeRuntime", "realtime CPU runtime"],
    ["KernelMemory", "kernel memory"],
  ] as const) {
    assertEmpty(hostConfig[field], `Podman ${label}`);
  }
  gpuDeviceArguments(hostConfig, gpuAttachment);
  if (
    boolean(hostConfig.AutoRemove, "Podman AutoRemove") ||
    boolean(hostConfig.AutoRemoveImage, "Podman AutoRemoveImage") ||
    boolean(hostConfig.PublishAllPorts, "Podman PublishAllPorts")
  ) {
    throw new Error(
      "Podman auto-removal and publish-all settings are not eligible for recreation.",
    );
  }
  const cgroups = optionalString(hostConfig.Cgroups, "Podman HostConfig.Cgroups");
  if (cgroups && cgroups !== "default") {
    throw new Error(`Podman cgroups mode '${cgroups}' cannot be reproduced faithfully.`);
  }
  for (const [field, allowed] of [
    ["IpcMode", ["", "shareable", "private"]],
    ["PidMode", ["", "private"]],
    ["UTSMode", ["", "private"]],
    ["UsernsMode", ["", "host"]],
    ["CgroupMode", ["", "private"]],
  ] as const) {
    const value = optionalString(hostConfig[field], `Podman HostConfig.${field}`);
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`Podman HostConfig.${field} '${value}' cannot be reproduced faithfully.`);
    }
  }
  assertEmpty(config.ChrootDirs, "Podman chroot directories");
}

export function buildPodmanManagedSandboxCreatePlan(options: {
  /** Null preserves the canonical command already present in inspect. */
  readonly command: readonly string[] | null;
  /** Optional image-owned bootstrap process boundary. */
  readonly containerCommand?: readonly string[];
  readonly containerEntrypoint?: readonly string[];
  readonly imagePins: Readonly<Record<string, string>>;
  readonly inspect: PodmanManagedSandboxInspect;
  readonly labels?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly requireCommandEnvironment?: boolean;
  readonly requiredUlimits?: readonly PodmanUlimit[];
  readonly gpuAttachment?: PodmanGpuAttachment | null;
}): PodmanManagedSandboxCreatePlan {
  const raw = options.inspect.raw;
  const config = record(raw.Config, "Podman inspect Config");
  const hostConfig = record(raw.HostConfig, "Podman inspect HostConfig");
  const gpuAttachment = options.gpuAttachment ?? null;
  assertSupportedShape(raw, config, hostConfig, gpuAttachment);
  const env = environment(config, options.command, options.requireCommandEnvironment === true);
  const mounts = array(raw.Mounts, "Podman inspect Mounts").map((entry, index) =>
    record(entry, `Podman inspect Mounts[${index}]`),
  );
  assertRequiredMounts(mounts, env, options.inspect.sandboxId);
  const createName = string(options.name ?? options.inspect.name, "Podman recreate container name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(createName)) {
    throw new Error("Podman recreate container name is malformed.");
  }
  const createLabels = options.labels ?? options.inspect.labels;

  const args: string[] = [
    "create",
    "--pull=never",
    "--http-proxy=false",
    "--name",
    createName,
    "--unsetenv-all",
    "--env-file",
    "/dev/stdin",
  ];
  for (const [key, value] of Object.entries(createLabels).sort(([a], [b]) => a.localeCompare(b))) {
    args.push(
      "--label",
      `${safeDelimitedValue(key, "Podman recreate label name")}=${safeLabelValue(
        value,
        `Podman recreate label ${key}`,
      )}`,
    );
  }
  args.push(
    ...hostArguments(config, hostConfig),
    ...capabilityAndSecurityArguments(hostConfig, gpuAttachment),
    ...gpuDeviceArguments(hostConfig, gpuAttachment),
    ...resourceArguments(hostConfig),
    ...ulimitArguments(hostConfig, options.requiredUlimits ?? []),
    ...networkAndPortArguments(raw, hostConfig),
    ...healthArguments(config),
    ...tmpfsArguments(hostConfig),
    ...secretArguments(config, env, options.inspect.sandboxId),
  );
  for (const [index, mount] of mounts.entries()) {
    args.push("--mount", mountValue(mount, options.imagePins, index));
  }
  const entrypoint =
    options.containerEntrypoint === undefined
      ? stringArray(config.Entrypoint, "Podman inspect Config.Entrypoint")
      : [...options.containerEntrypoint];
  if (entrypoint.length > 0) args.push("--entrypoint", JSON.stringify(entrypoint));
  args.push(options.inspect.immutableImage);
  args.push(
    ...(options.containerCommand === undefined
      ? stringArray(config.Cmd, "Podman inspect Config.Cmd")
      : [...options.containerCommand]),
  );
  return {
    args,
    environmentInput: environmentFileInput(env),
    immutableImage: options.inspect.immutableImage,
  };
}

/** Remove every v0.0.85 OpenShell identity label so watcher events cannot match the backup. */
export function podmanWatcherInvisibleBackupLabels(
  inspect: Pick<PodmanManagedSandboxInspect, "labels">,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(inspect.labels).filter(
      ([label]) => !PODMAN_OPEN_SHELL_IDENTITY_LABELS.has(label),
    ),
  );
}
