// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  dockerRename as defaultDockerRename,
  dockerRm as defaultDockerRm,
  dockerStart as defaultDockerStart,
  dockerStop as defaultDockerStop,
} from "../../adapters/docker/container";
import {
  dockerCapture as defaultDockerCapture,
  dockerRun as defaultDockerRun,
} from "../../adapters/docker/run";
import { parseOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import { hasZeroDockerExitStatus } from "../docker-command-result";
import { buildDockerGpuCloneRunArgs, dockerContainerName } from "../docker-gpu-patch-clone";
import {
  DOCKER_GPU_PATCH_STOP_TIMEOUT_MS,
  DOCKER_GPU_PATCH_TIMEOUT_MS,
} from "../docker-gpu-patch-constants";
import type {
  DockerContainerInspect,
  DockerGpuPatchDeps,
  DockerGpuPatchMode,
  DockerGpuPatchModeKind,
  DockerUlimit,
} from "../docker-gpu-patch-types";
import { waitForOpenShellSupervisorReconnect } from "../docker-gpu-supervisor-reconnect";
import { openshellSandboxCommandEnvValue } from "../docker-startup-command-env";
import {
  clearDockerManagedStartupSharedStateCommitReceipt,
  DockerManagedStartupSharedStateCommitIndeterminateError,
  finalizeDockerManagedStartupSharedState,
  probeDockerManagedStartupSharedState,
} from "../managed-startup/docker-shared-state";
import {
  isImmutableDockerImageId,
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  queryOpenShellDockerSandboxContainers,
} from "../openshell-docker-sandbox-containers";
import { cleanupTempDir, secureTempFile } from "../temp-files";
import {
  assertManagedBootstrapIdentity,
  assertManagedBootstrapSafeProcessEnvironmentKey,
  attachManagedBootstrapRollbackError,
  createManagedBootstrapIdentity,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapAdapter,
  ManagedBootstrapCommitStateIndeterminateError,
  type ManagedBootstrapCompletionReceipt,
  type ManagedBootstrapDiscoveredWorkload,
  type ManagedBootstrapDiscoveryInput,
  ManagedBootstrapDurableCommitCleanupPendingError,
  type ManagedBootstrapFinalizationReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  type ManagedBootstrapIncompleteCreateCleanupInput,
  type ManagedBootstrapObservedSnapshot,
  ManagedBootstrapOwnerCleanupRequiredError,
  type ManagedBootstrapReplacementHandle,
  type ManagedBootstrapReplacementOptions,
  type ManagedBootstrapSandboxIdentity,
  renderManagedBootstrapHeldCommand,
} from "./adapter";
import {
  normalizeDockerManagedBootstrapLaunchSpec,
  parseDockerManagedBootstrapLaunchSpec,
  parseExactDockerContainerInspect,
} from "./docker-spec";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  parseManagedBootstrapImageCompletion,
  serializeManagedBootstrapEnvelope,
} from "./envelope";

const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const FULL_SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_ARGV_BYTES = 128 * 1024;
const MAX_CONTAINER_NAME_LENGTH = 253;
const REQUEST_TEMP_PREFIX = "nemoclaw-managed-bootstrap-request";
const COMPLETION_TEMP_PREFIX = "nemoclaw-managed-bootstrap-completion";
const COMPLETION_MAX_BYTES = 4096;
const DOCKER_DRIVER_ID = "docker";

export const MANAGED_BOOTSTRAP_TRAMPOLINE_EXECUTABLE = "/usr/local/bin/nemoclaw-managed-bootstrap";

type DockerCommandResult = {
  readonly status?: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: Error | null;
};

export type DockerManagedBootstrapDeps = Pick<
  DockerGpuPatchDeps,
  | "dockerCapture"
  | "dockerRename"
  | "dockerRm"
  | "dockerRun"
  | "dockerStart"
  | "dockerStop"
  | "runCaptureOpenshell"
  | "runOpenshell"
  | "sleep"
  | "now"
> & {
  readonly createBootstrapIdentity?: () => string;
};

type ResolvedDeps = Required<
  Pick<
    DockerManagedBootstrapDeps,
    | "dockerCapture"
    | "dockerRename"
    | "dockerRm"
    | "dockerRun"
    | "dockerStart"
    | "dockerStop"
    | "now"
    | "createBootstrapIdentity"
  >
> &
  DockerManagedBootstrapDeps;

interface DockerBootstrapTransaction {
  readonly bootstrapIdentity: string;
  readonly originalRuntimeId: string;
  readonly replacementRuntimeId: string;
  readonly originalName: string;
  readonly backupName: string;
  readonly originalSpecHash: string;
}

interface DockerBootstrapRollbackTombstone {
  readonly profileFingerprint: string;
  readonly imageReference: string;
  readonly receipt: ManagedBootstrapFinalizationReceipt;
}

export interface DockerManagedBootstrapAdapter extends ManagedBootstrapAdapter {}

function resolveDeps(deps: DockerManagedBootstrapDeps): ResolvedDeps {
  return {
    dockerCapture: defaultDockerCapture,
    dockerRename: defaultDockerRename,
    dockerRm: defaultDockerRm,
    dockerRun: defaultDockerRun,
    dockerStart: defaultDockerStart,
    dockerStop: defaultDockerStop,
    now: () => new Date(),
    createBootstrapIdentity: createManagedBootstrapIdentity,
    ...deps,
  };
}

function commandDetail(result: DockerCommandResult): string {
  return `${String(result.stderr ?? "")} ${String(result.stdout ?? "")} ${String(
    result.error?.message ?? "",
  )}`
    .trim()
    .slice(-1200);
}

function isExactMissingDockerContainer(containerId: string, result: DockerCommandResult): boolean {
  const escapedContainerId = containerId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(
      `^(?:Error response from daemon: )?No such (?:container|object): ${escapedContainerId}$`,
      "u",
    ),
    new RegExp(`^Error: No such (?:container|object): ${escapedContainerId}$`, "u"),
  ];
  return [result.stderr, result.stdout, result.error?.message]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .some((detail) => patterns.some((pattern) => pattern.test(detail)));
}

function probeExactDockerContainerAbsence(
  containerId: string,
  deps: ResolvedDeps,
): "absent" | "present" | "unknown" {
  let result: DockerCommandResult;
  try {
    result = deps.dockerRun(["inspect", "--type", "container", containerId], {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
  } catch {
    return "unknown";
  }
  if (hasZeroDockerExitStatus(result)) return "present";
  return isExactMissingDockerContainer(containerId, result) ? "absent" : "unknown";
}

function assertZero(result: DockerCommandResult, message: string): void {
  if (!hasZeroDockerExitStatus(result)) {
    throw new Error(`${message}: ${commandDetail(result) || "Docker command failed"}`);
  }
}

function exactStringArray(value: unknown, label: string): string[] {
  if (value === null || value === undefined) return [];
  const values = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(values) ||
    values.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.includes("\0") ||
        Buffer.byteLength(item, "utf8") > 64 * 1024,
    )
  ) {
    throw new Error(`Managed bootstrap Docker ${label} is not an exact bounded argv.`);
  }
  const result = [...values];
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_ARGV_BYTES) {
    throw new Error(`Managed bootstrap Docker ${label} exceeds its bounded argv transport.`);
  }
  return result;
}

function exactSupervisorArgv(inspect: DockerContainerInspect): readonly string[] {
  const argv = [
    ...exactStringArray(inspect.Config?.Entrypoint, "entrypoint"),
    ...exactStringArray(inspect.Config?.Cmd, "command"),
  ];
  if (argv.length === 0 || !argv[0]?.startsWith("/")) {
    throw new Error(
      "Managed bootstrap requires one bounded absolute supervisor argv from Docker inspect.",
    );
  }
  return Object.freeze(argv);
}

function exactArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function envValue(env: readonly string[] | null | undefined, key: string): string | null {
  const prefix = `${key}=`;
  const matches = (env ?? []).filter((value) => value.startsWith(prefix));
  return matches.length === 1 ? (matches[0]?.slice(prefix.length) ?? null) : null;
}

function assertNoRootProcessInjectionEnvironment(env: readonly string[] | null | undefined): void {
  for (const entry of env ?? []) {
    const separator = entry.indexOf("=");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    try {
      assertManagedBootstrapSafeProcessEnvironmentKey(key);
    } catch {
      throw new Error(`Managed bootstrap refuses root-process injection environment '${key}'.`);
    }
  }
}

function assertRootSupervisor(inspect: DockerContainerInspect): void {
  const user = String(inspect.Config?.User ?? "")
    .trim()
    .toLowerCase();
  if (!["", "0", "0:0", "root", "root:root"].includes(user)) {
    throw new Error("Managed bootstrap Docker workload must retain a root supervisor user.");
  }
}

function assertStableRunning(inspect: DockerContainerInspect, label: string): void {
  if (
    inspect.State?.Running !== true ||
    inspect.State.Paused === true ||
    inspect.State.Restarting === true ||
    inspect.State.Dead === true
  ) {
    throw new Error(`Managed bootstrap Docker ${label} is not stably running.`);
  }
}

function expectedImageReference(repository: string, manifestDigest: string): string {
  if (
    repository.length === 0 ||
    repository !== repository.trim() ||
    repository.includes("@") ||
    repository.includes("\0") ||
    !FULL_SHA256_RE.test(manifestDigest)
  ) {
    throw new Error("Managed bootstrap image repository/manifest identity is invalid.");
  }
  return `${repository}@${manifestDigest}`;
}

function assertImage(
  inspect: DockerContainerInspect,
  image: ManagedBootstrapHeldWorkloadHandle["plan"]["image"],
  deps: ResolvedDeps,
): string {
  const runtimeContentId = String(inspect.Image ?? "").toLowerCase();
  if (!FULL_SHA256_RE.test(runtimeContentId)) {
    throw new Error("Managed bootstrap Docker image does not have an immutable local content ID.");
  }
  const expectedReference = expectedImageReference(image.repository, image.manifestDigest);
  const configuredImage = String(inspect.Config?.Image ?? "").trim();
  if (configuredImage !== expectedReference) {
    throw new Error(
      "Managed bootstrap Docker configured image is not the exact repository@manifestDigest.",
    );
  }
  const imageOutput = deps.dockerCapture(["image", "inspect", expectedReference], {
    ignoreError: false,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(imageOutput);
  } catch {
    throw new Error("Managed bootstrap Docker image evidence is malformed.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Managed bootstrap Docker image evidence is not exact.");
  }
  const evidence = parsed[0] as {
    readonly Id?: unknown;
    readonly RepoDigests?: unknown;
  };
  const evidenceId = String(evidence.Id ?? "").toLowerCase();
  const repoDigests = Array.isArray(evidence.RepoDigests)
    ? evidence.RepoDigests.filter((value): value is string => typeof value === "string")
    : [];
  if (evidenceId !== runtimeContentId || !repoDigests.includes(expectedReference)) {
    throw new Error(
      "Managed bootstrap Docker image manifest evidence does not match its local content ID.",
    );
  }
  return runtimeContentId;
}

function assertMetadata(
  inspect: DockerContainerInspect,
  sandbox: ManagedBootstrapHeldWorkloadHandle["sandbox"],
  metadata: Readonly<Record<string, string>>,
): void {
  const labels = inspect.Config?.Labels ?? {};
  if (
    labels[OPENSHELL_MANAGED_BY_LABEL] !== OPENSHELL_MANAGED_BY_VALUE ||
    labels[OPENSHELL_SANDBOX_NAME_LABEL] !== sandbox.sandboxName ||
    labels[OPENSHELL_SANDBOX_ID_LABEL] !== sandbox.sandboxId
  ) {
    throw new Error(
      "Managed bootstrap Docker workload does not match the durable OpenShell sandbox identity.",
    );
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (labels[key] !== value) {
      throw new Error(`Managed bootstrap Docker metadata label '${key}' changed.`);
    }
  }
}

function assertHeldCommand(
  inspect: DockerContainerInspect,
  heldWorkloadArgv: readonly string[],
  bootstrapIdentity: string,
): void {
  assertManagedBootstrapIdentity(bootstrapIdentity);
  const expected = openshellSandboxCommandEnvValue(heldWorkloadArgv);
  const observed = envValue(inspect.Config?.Env, "OPENSHELL_SANDBOX_COMMAND");
  if (!expected || observed !== expected) {
    throw new Error(
      "Managed bootstrap Docker workload does not contain the exact identity-bound hold.",
    );
  }
  const identityIndexes = heldWorkloadArgv
    .map((value, index) => (value === bootstrapIdentity ? index : -1))
    .filter((index) => index >= 0);
  if (identityIndexes.length !== 1) {
    throw new Error("Managed bootstrap hold does not contain exactly one bootstrap identity.");
  }
}

function assertBootstrapIdentityInObservedHold(
  inspect: DockerContainerInspect,
  bootstrapIdentity: string,
): void {
  assertManagedBootstrapIdentity(bootstrapIdentity);
  const observed = envValue(inspect.Config?.Env, "OPENSHELL_SANDBOX_COMMAND");
  if (!observed) {
    throw new Error("Managed bootstrap Docker workload is missing its held command.");
  }
  const occurrences = observed.split(bootstrapIdentity).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      "Managed bootstrap Docker held command does not contain one exact bootstrap identity.",
    );
  }
}

function inspectExact(containerId: string, deps: ResolvedDeps): DockerContainerInspect {
  if (!FULL_CONTAINER_ID_RE.test(containerId)) {
    throw new Error("Managed bootstrap requires one full lowercase Docker container ID.");
  }
  const output = deps.dockerCapture(["inspect", "--type", "container", containerId], {
    ignoreError: false,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  });
  const inspect = parseExactDockerContainerInspect(output);
  if (String(inspect.Id ?? "").toLowerCase() !== containerId) {
    throw new Error("Managed bootstrap Docker workload identity changed during inspection.");
  }
  return inspect;
}

function tryInspectExact(containerId: string, deps: ResolvedDeps): DockerContainerInspect | null {
  try {
    return inspectExact(containerId, deps);
  } catch {
    return null;
  }
}

function backupName(originalName: string, bootstrapIdentity: string): string {
  const suffix = `-nemoclaw-bootstrap-${bootstrapIdentity.slice(0, 20)}`;
  return `${originalName.slice(0, Math.max(1, MAX_CONTAINER_NAME_LENGTH - suffix.length))}${suffix}`;
}

function writeProtectedEnvelope(
  bootstrapIdentity: string,
  request: Parameters<typeof serializeManagedBootstrapEnvelope>[0]["rootApplyRequest"],
): string {
  const file = secureTempFile(REQUEST_TEMP_PREFIX, ".json");
  try {
    fs.writeFileSync(
      file,
      serializeManagedBootstrapEnvelope({ bootstrapIdentity, rootApplyRequest: request }),
      { encoding: "utf8", flag: "wx", mode: 0o400 },
    );
    fs.chmodSync(file, 0o400);
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o400
    ) {
      throw new Error("Managed bootstrap request source is not one protected 0400 file.");
    }
    return file;
  } catch (error) {
    cleanupTempDir(file, REQUEST_TEMP_PREFIX);
    throw error;
  }
}

function readProtectedImageCompletion(
  replacementRuntimeId: string,
  deps: ResolvedDeps,
): ReturnType<typeof parseManagedBootstrapImageCompletion> {
  const file = secureTempFile(COMPLETION_TEMP_PREFIX, ".json");
  let descriptor: number | undefined;
  try {
    const copied = deps.dockerRun(
      ["cp", `${replacementRuntimeId}:${MANAGED_BOOTSTRAP_COMPLETION_FILE}`, file],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      },
    );
    assertZero(copied, "Managed bootstrap could not retrieve its image completion receipt");
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      Number(before.mode & 0o777n) !== 0o444 ||
      before.size < 1n ||
      before.size > BigInt(COMPLETION_MAX_BYTES)
    ) {
      throw new Error("Managed bootstrap image completion is not one protected bounded 0444 file.");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.length ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink
    ) {
      throw new Error("Managed bootstrap image completion changed during stable read.");
    }
    return parseManagedBootstrapImageCompletion(bytes.toString("utf8"));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    cleanupTempDir(file, COMPLETION_TEMP_PREFIX);
  }
}

function parseRequiredUlimits(value: unknown): DockerUlimit[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.includes("\0"))
  ) {
    throw new Error("Managed bootstrap Docker requiredUlimits must be string entries.");
  }
  return value.map((entry) => {
    const match = /^([a-z][a-z0-9_]*)=(\d+):(\d+)$/u.exec(entry);
    if (!match) {
      throw new Error(`Managed bootstrap Docker ulimit '${entry}' is invalid.`);
    }
    const soft = Number(match[2]);
    const hard = Number(match[3]);
    if (!Number.isSafeInteger(soft) || !Number.isSafeInteger(hard) || hard < soft) {
      throw new Error(`Managed bootstrap Docker ulimit '${entry}' is invalid.`);
    }
    return { name: match[1] as string, soft, hard };
  });
}

function replacementPlan(options: ManagedBootstrapReplacementOptions): {
  readonly mode: DockerGpuPatchMode;
  readonly requiredUlimits: readonly DockerUlimit[];
  readonly extraGroupGids: readonly string[];
} {
  const allowed = new Set([
    "gpuModeArgs",
    "gpuModeDevice",
    "gpuModeKind",
    "gpuModeLabel",
    "extraGroupGids",
    "requiredUlimits",
  ]);
  const unknown = Object.keys(options.values).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Managed bootstrap Docker replacement options are unsupported: ${unknown.sort().join(", ")}.`,
    );
  }
  const kind = String(options.values.gpuModeKind ?? "startup-command") as DockerGpuPatchModeKind;
  if (!["gpus", "nvidia-runtime", "cdi", "startup-command"].includes(kind)) {
    throw new Error(`Managed bootstrap Docker GPU mode '${kind}' is invalid.`);
  }
  const args = exactStringArray(options.values.gpuModeArgs ?? [], "GPU mode arguments");
  return {
    mode: {
      kind,
      label: String(options.values.gpuModeLabel ?? "managed bootstrap"),
      device: String(options.values.gpuModeDevice ?? ""),
      args,
    },
    extraGroupGids: exactStringArray(options.values.extraGroupGids ?? [], "extra group GIDs").map(
      (value) => {
        if (!/^\d+$/u.test(value)) {
          throw new Error(`Managed bootstrap Docker supplementary group '${value}' is invalid.`);
        }
        return value;
      },
    ),
    requiredUlimits: parseRequiredUlimits(options.values.requiredUlimits),
  };
}

function replacementCommand(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
): readonly string[] {
  return Object.freeze([
    "--agent",
    handle.plan.profile.agent,
    "--profile-fingerprint",
    handle.plan.profile.fingerprint,
    "--bootstrap-identity",
    handle.bootstrapIdentity,
    "--agent-uid",
    String(snapshot.agentIdentity.uid),
    "--agent-gid",
    String(snapshot.agentIdentity.gid),
    "--agent-workdir",
    snapshot.agentIdentity.workdir,
    "--request-file",
    MANAGED_BOOTSTRAP_REQUEST_FILE,
    "--",
    ...snapshot.supervisorArgv,
  ]);
}

function assertReplacementBoundary(
  inspect: DockerContainerInspect,
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
): void {
  const entrypoint = exactStringArray(inspect.Config?.Entrypoint, "replacement entrypoint");
  const command = exactStringArray(inspect.Config?.Cmd, "replacement command");
  if (
    !exactArrayEqual(entrypoint, [MANAGED_BOOTSTRAP_TRAMPOLINE_EXECUTABLE]) ||
    !exactArrayEqual(command, replacementCommand(handle, snapshot))
  ) {
    throw new Error("Managed bootstrap Docker replacement process boundary changed.");
  }
  const intended = openshellSandboxCommandEnvValue(handle.intendedWorkloadArgv);
  if (envValue(inspect.Config?.Env, "OPENSHELL_SANDBOX_COMMAND") !== intended) {
    throw new Error(
      "Managed bootstrap Docker replacement did not restore the intended sandbox command.",
    );
  }
}

const REPLACED_GPU_ENV_KEYS = new Set([
  "NVIDIA_DISABLE_REQUIRE",
  "NVIDIA_DRIVER_CAPABILITIES",
  "NVIDIA_REQUIRE_CUDA",
  "NVIDIA_VISIBLE_DEVICES",
]);

function canonicalObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Managed bootstrap normalized Docker spec is not an object.");
  }
  return value as Record<string, unknown>;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Managed bootstrap normalized Docker spec is missing ${key}.`);
  }
  return value as Record<string, unknown>;
}

function exactJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function stringSet(value: unknown, label: string): string[] {
  const values = exactStringArray(value ?? [], label);
  if (new Set(values).size !== values.length) {
    throw new Error(`Managed bootstrap Docker ${label} contains duplicate entries.`);
  }
  return values.sort();
}

function assertExactStringSet(observed: unknown, expected: readonly string[], label: string): void {
  if (!exactArrayEqual(stringSet(observed, label), [...expected].sort())) {
    throw new Error(`Managed bootstrap Docker ${label} changed outside declared deltas.`);
  }
}

function modeEnvironment(mode: DockerGpuPatchMode): string[] {
  const values: string[] = [];
  for (let index = 0; index < mode.args.length; index += 1) {
    if (mode.args[index] === "--env") {
      const value = mode.args[index + 1];
      if (!value || !value.includes("=")) {
        throw new Error("Managed bootstrap Docker GPU mode has an invalid environment delta.");
      }
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function assertExactEnvironmentDelta(
  original: Record<string, unknown>,
  replacement: Record<string, unknown>,
  mode: DockerGpuPatchMode,
  intendedSandboxCommand: string,
): void {
  const gpuAugment = mode.kind !== "startup-command";
  const originalEnv = exactStringArray(original.Env ?? [], "original environment");
  const expected = [
    ...modeEnvironment(mode),
    ...originalEnv
      .filter((entry) => !gpuAugment || !REPLACED_GPU_ENV_KEYS.has(entry.split("=", 1)[0] ?? ""))
      .map((entry) =>
        entry.startsWith("OPENSHELL_SANDBOX_COMMAND=")
          ? `OPENSHELL_SANDBOX_COMMAND=${intendedSandboxCommand}`
          : entry,
      ),
  ];
  const observed = exactStringArray(replacement.Env ?? [], "replacement environment");
  if (!exactArrayEqual(observed, expected)) {
    throw new Error(
      "Managed bootstrap Docker replacement environment changed outside declared deltas.",
    );
  }
}

function canonicalUlimits(value: unknown, label: string): string {
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) return "[]";
    throw new Error(`Managed bootstrap Docker ${label} is invalid.`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Managed bootstrap Docker ${label} is invalid.`);
    }
    const record = entry as Record<string, unknown>;
    const name = String(record.Name ?? "");
    const soft = record.Soft;
    const hard = record.Hard;
    if (!name || !Number.isSafeInteger(soft) || !Number.isSafeInteger(hard)) {
      throw new Error(`Managed bootstrap Docker ${label} is invalid.`);
    }
    return { Hard: hard, Name: name, Soft: soft };
  });
  if (new Set(normalized.map((entry) => entry.Name)).size !== normalized.length) {
    throw new Error(`Managed bootstrap Docker ${label} contains duplicate entries.`);
  }
  return JSON.stringify(normalized.sort((left, right) => left.Name.localeCompare(right.Name)));
}

function expectedUlimits(original: unknown, required: readonly DockerUlimit[]): string {
  const existing = JSON.parse(canonicalUlimits(original, "original ulimits")) as Array<{
    Hard: number;
    Name: string;
    Soft: number;
  }>;
  const merged = new Map(existing.map((entry) => [entry.Name, entry]));
  for (const requiredEntry of required) {
    merged.set(requiredEntry.name, {
      Name: requiredEntry.name,
      Soft: requiredEntry.soft,
      Hard: requiredEntry.hard,
    });
  }
  return JSON.stringify(
    [...merged.values()].sort((left, right) => left.Name.localeCompare(right.Name)),
  );
}

function assertExactDeviceRequests(
  original: unknown,
  observed: unknown,
  mode: DockerGpuPatchMode,
): void {
  if (mode.kind === "startup-command") {
    if (exactJson(observed) !== exactJson(original)) {
      throw new Error("Managed bootstrap Docker device requests were not preserved exactly.");
    }
    return;
  }
  if (Array.isArray(original) && original.length > 0) {
    throw new Error(
      "Managed bootstrap Docker GPU augmentation cannot replace an existing device request.",
    );
  }
  const requests = Array.isArray(observed) ? observed : [];
  if (mode.kind === "nvidia-runtime") {
    if (requests.length !== 0) {
      throw new Error(
        "Managed bootstrap Docker NVIDIA runtime added an undeclared device request.",
      );
    }
    return;
  }
  if (requests.length !== 1 || typeof requests[0] !== "object" || requests[0] === null) {
    throw new Error("Managed bootstrap Docker GPU mode did not add one exact device request.");
  }
  const request = requests[0] as Record<string, unknown>;
  if (mode.kind === "gpus") {
    const all = mode.device === "all";
    const expectedIds = all ? [] : [mode.device];
    const ids = Array.isArray(request.DeviceIDs) ? request.DeviceIDs : [];
    if (
      String(request.Driver ?? "") !== "" ||
      Number(request.Count) !== (all ? -1 : 0) ||
      !exactArrayEqual(ids.map(String), expectedIds) ||
      exactJson(request.Capabilities) !== JSON.stringify([["gpu"]]) ||
      exactJson(request.Options ?? {}) !== "{}"
    ) {
      throw new Error("Managed bootstrap Docker --gpus request changed outside its exact delta.");
    }
    return;
  }
  const ids = Array.isArray(request.DeviceIDs) ? request.DeviceIDs.map(String) : [];
  if (
    request.Driver !== "cdi" ||
    ![-1, 0].includes(Number(request.Count ?? 0)) ||
    !exactArrayEqual(ids, [mode.device]) ||
    (request.Capabilities != null &&
      (!Array.isArray(request.Capabilities) || request.Capabilities.length > 0)) ||
    exactJson(request.Options ?? {}) !== "{}"
  ) {
    throw new Error("Managed bootstrap Docker CDI request changed outside its exact delta.");
  }
}

function scrubVerifiedReplacementDeltas(canonicalJson: string): string {
  const root = canonicalObject(canonicalJson);
  const inspect = objectField(root, "inspect");
  const config = objectField(inspect, "Config");
  const host = objectField(inspect, "HostConfig");
  config.Image = "<immutable-image>";
  config.Entrypoint = ["<managed-bootstrap-trampoline>"];
  config.Cmd = ["<identity-bound-bootstrap-command>"];
  config.Env = "<verified-environment-delta>";
  for (const key of [
    "CapAdd",
    "DeviceRequests",
    "Devices",
    "GroupAdd",
    "Runtime",
    "SecurityOpt",
    "Ulimits",
  ]) {
    host[key] = `<verified-${key}>`;
  }
  return JSON.stringify(root);
}

function assertReplacementMatchesIntent(
  originalCanonicalJson: string,
  replacement: DockerContainerInspect,
  plan: {
    readonly mode: DockerGpuPatchMode;
    readonly requiredUlimits: readonly DockerUlimit[];
    readonly extraGroupGids: readonly string[];
  },
  intendedSandboxCommand: string,
): string {
  const original = canonicalObject(originalCanonicalJson);
  const originalInspect = objectField(original, "inspect");
  const originalConfig = objectField(originalInspect, "Config");
  const originalHost = objectField(originalInspect, "HostConfig");
  const replacementSpec = normalizeDockerManagedBootstrapLaunchSpec(replacement);
  const observed = canonicalObject(replacementSpec.canonicalJson);
  const observedInspect = objectField(observed, "inspect");
  const observedConfig = objectField(observedInspect, "Config");
  const observedHost = objectField(observedInspect, "HostConfig");
  const gpuAugment = plan.mode.kind !== "startup-command";
  assertExactEnvironmentDelta(originalConfig, observedConfig, plan.mode, intendedSandboxCommand);
  assertExactStringSet(
    observedHost.CapAdd,
    [
      ...stringSet(originalHost.CapAdd, "original capability additions"),
      ...(gpuAugment ? ["SYS_PTRACE"] : []),
    ].filter((value, index, values) => values.indexOf(value) === index),
    "capability additions",
  );
  const originalSecurity = stringSet(originalHost.SecurityOpt, "original security options");
  assertExactStringSet(
    observedHost.SecurityOpt,
    [
      ...originalSecurity,
      ...(gpuAugment && !originalSecurity.some((value) => value.startsWith("apparmor"))
        ? ["apparmor=unconfined"]
        : []),
    ],
    "security options",
  );
  if (exactJson(observedHost.Devices) !== exactJson(originalHost.Devices)) {
    throw new Error("Managed bootstrap Docker non-GPU devices were not preserved exactly.");
  }
  assertExactDeviceRequests(originalHost.DeviceRequests, observedHost.DeviceRequests, plan.mode);
  const expectedRuntime = plan.mode.kind === "nvidia-runtime" ? "nvidia" : originalHost.Runtime;
  if (exactJson(observedHost.Runtime) !== exactJson(expectedRuntime)) {
    throw new Error("Managed bootstrap Docker runtime changed outside its selected GPU delta.");
  }
  assertExactStringSet(
    observedHost.GroupAdd,
    [
      ...stringSet(originalHost.GroupAdd, "original supplementary groups"),
      ...plan.extraGroupGids,
    ].filter((value, index, values) => values.indexOf(value) === index),
    "supplementary groups",
  );
  if (
    canonicalUlimits(observedHost.Ulimits, "replacement ulimits") !==
    expectedUlimits(originalHost.Ulimits, plan.requiredUlimits)
  ) {
    throw new Error("Managed bootstrap Docker ulimits changed outside declared requirements.");
  }
  const expectedPreserved = scrubVerifiedReplacementDeltas(originalCanonicalJson);
  const observedPreserved = scrubVerifiedReplacementDeltas(replacementSpec.canonicalJson);
  if (observedPreserved !== expectedPreserved) {
    throw new Error(
      "Managed bootstrap Docker replacement normalized spec changed outside declared deltas.",
    );
  }
  return replacementSpec.hash;
}

function restoreOriginal(transaction: DockerBootstrapTransaction, deps: ResolvedDeps): void {
  const options = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  const originalBeforeReplacementRemoval = inspectExact(transaction.originalRuntimeId, deps);
  const currentOriginalName = dockerContainerName(originalBeforeReplacementRemoval);
  if (
    currentOriginalName !== transaction.backupName &&
    currentOriginalName !== transaction.originalName
  ) {
    throw new Error("Managed bootstrap original container has an unexpected rollback name.");
  }
  const originalSpecBeforeReplacementRemoval = normalizeDockerManagedBootstrapLaunchSpec({
    ...originalBeforeReplacementRemoval,
    Name: `/${transaction.originalName}`,
  });
  if (originalSpecBeforeReplacementRemoval.hash !== transaction.originalSpecHash) {
    throw new Error(
      "Managed bootstrap refused rollback because the exact original launch spec changed.",
    );
  }
  const replacement = tryInspectExact(transaction.replacementRuntimeId, deps);
  if (replacement) {
    deps.dockerStop(transaction.replacementRuntimeId, {
      ...options,
      timeout: DOCKER_GPU_PATCH_STOP_TIMEOUT_MS,
    });
    assertZero(
      deps.dockerRm(transaction.replacementRuntimeId, options),
      "Managed bootstrap could not remove its replacement during rollback",
    );
  }
  const original = inspectExact(transaction.originalRuntimeId, deps);
  const currentName = dockerContainerName(original);
  if (currentName !== transaction.originalName) {
    if (currentName !== transaction.backupName) {
      throw new Error("Managed bootstrap original container has an unexpected rollback name.");
    }
    assertZero(
      deps.dockerRename(transaction.originalRuntimeId, transaction.originalName, options),
      "Managed bootstrap could not restore the original container name",
    );
  }
  const restoredBeforeStart = inspectExact(transaction.originalRuntimeId, deps);
  if (restoredBeforeStart.State?.Running !== true) {
    assertZero(
      deps.dockerStart(transaction.originalRuntimeId, options),
      "Managed bootstrap could not restart the original container",
    );
  }
  const restored = inspectExact(transaction.originalRuntimeId, deps);
  assertStableRunning(restored, "restored workload");
  const normalized = normalizeDockerManagedBootstrapLaunchSpec(restored);
  if (normalized.hash !== transaction.originalSpecHash) {
    throw new Error("Managed bootstrap rollback did not restore the exact launch spec.");
  }
}

function removeOwnedWorkload(
  sandbox: ManagedBootstrapSandboxIdentity,
  deps: ResolvedDeps,
  expectedRuntimeId?: string,
): never {
  const expectedIdentity =
    expectedRuntimeId === undefined
      ? `sandbox ${sandbox.sandboxId} with no previously resolved runtime ID`
      : `sandbox ${sandbox.sandboxId} expected runtime ${expectedRuntimeId}`;
  let containers: DockerCommandResult;
  try {
    containers = deps.dockerRun(
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--filter",
        `label=${OPENSHELL_SANDBOX_ID_LABEL}=${sandbox.sandboxId}`,
        "--format",
        "{{.ID}}",
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      },
    );
  } catch (error) {
    throw new Error(
      `Managed bootstrap owner cleanup could not enumerate the exact held runtime for ${expectedIdentity}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (Number(containers.status ?? 1) !== 0) {
    throw new Error(
      `Managed bootstrap owner cleanup could not verify the exact held runtime for ${expectedIdentity}: ${
        commandDetail(containers) || "Docker enumeration failed"
      }`,
    );
  }
  const runtimeIds = String(containers.stdout ?? "")
    .trim()
    .split(/\r?\n/u)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    runtimeIds.length !== 1 ||
    !FULL_CONTAINER_ID_RE.test(runtimeIds[0] ?? "") ||
    (expectedRuntimeId !== undefined && runtimeIds[0] !== expectedRuntimeId)
  ) {
    throw new Error(
      `Managed bootstrap owner cleanup could not bind retention for ${expectedIdentity}; resolved runtime IDs: ${
        runtimeIds.length === 0 ? "none" : runtimeIds.join(", ")
      }.`,
    );
  }
  const runtimeId = runtimeIds[0] as string;
  let inspect: DockerContainerInspect;
  try {
    inspect = inspectExact(runtimeId, deps);
  } catch (error) {
    throw new Error(
      `Managed bootstrap could not inspect retained sandbox ${sandbox.sandboxId} exact runtime ${runtimeId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const labels = inspect.Config?.Labels ?? {};
  if (
    labels[OPENSHELL_MANAGED_BY_LABEL] !== OPENSHELL_MANAGED_BY_VALUE ||
    labels[OPENSHELL_SANDBOX_NAME_LABEL] !== sandbox.sandboxName ||
    labels[OPENSHELL_SANDBOX_ID_LABEL] !== sandbox.sandboxId
  ) {
    throw new Error(
      `Managed bootstrap owner cleanup refused retention after exact runtime ${runtimeId} ownership changed for sandbox ${sandbox.sandboxId}.`,
    );
  }
  let stopped: DockerCommandResult;
  try {
    stopped = deps.dockerStop(runtimeId, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_STOP_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `Managed bootstrap could not quiesce retained sandbox ${sandbox.sandboxId} exact runtime ${runtimeId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assertZero(
    stopped,
    `Managed bootstrap could not quiesce retained sandbox ${sandbox.sandboxId} exact runtime ${runtimeId}`,
  );
  let retained: DockerContainerInspect;
  try {
    retained = inspectExact(runtimeId, deps);
  } catch (error) {
    throw new Error(
      `Managed bootstrap could not re-inspect quiesced sandbox ${sandbox.sandboxId} exact runtime ${runtimeId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    retained.State?.Running !== false ||
    retained.State.Paused !== false ||
    retained.State.Restarting !== false
  ) {
    throw new Error(
      `Managed bootstrap retained sandbox ${sandbox.sandboxId} exact runtime ${runtimeId} did not prove an explicitly quiescent state.`,
    );
  }
  if (!deps.runCaptureOpenshell) {
    throw new ManagedBootstrapOwnerCleanupRequiredError({
      sandboxName: sandbox.sandboxName,
      sandboxId: sandbox.sandboxId,
      runtimeId,
    });
  }
  let getBeforeDelete: string;
  try {
    getBeforeDelete = deps.runCaptureOpenshell(["sandbox", "get", sandbox.sandboxName], {
      ignoreError: false,
    });
  } catch (error) {
    throw new ManagedBootstrapOwnerCleanupRequiredError({
      sandboxName: sandbox.sandboxName,
      sandboxId: sandbox.sandboxId,
      runtimeId,
      detail: `OpenShell owner lookup also failed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    });
  }
  const sandboxIdBeforeDelete = parseOpenShellSandboxId(getBeforeDelete);
  if (sandboxIdBeforeDelete !== sandbox.sandboxId) {
    throw new ManagedBootstrapOwnerCleanupRequiredError({
      sandboxName: sandbox.sandboxName,
      sandboxId: sandbox.sandboxId,
      runtimeId,
      detail: `The same mutable name now resolves to durable sandbox ID ${
        sandboxIdBeforeDelete ?? "unknown"
      } instead of ${sandbox.sandboxId}.`,
    });
  }
  throw new ManagedBootstrapOwnerCleanupRequiredError({
    sandboxName: sandbox.sandboxName,
    sandboxId: sandbox.sandboxId,
    runtimeId,
  });
}

function resolveIncompleteCreateSandbox(
  input: ManagedBootstrapIncompleteCreateCleanupInput,
  deps: ResolvedDeps,
): {
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly runtimeId: string;
} {
  if (
    input.plan.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
    input.plan.driverId !== DOCKER_DRIVER_ID
  ) {
    throw new Error("Managed bootstrap Docker incomplete-create cleanup received another driver.");
  }
  assertManagedBootstrapIdentity(input.bootstrapIdentity);
  const query = queryOpenShellDockerSandboxContainers(input.plan.sandboxName, deps);
  if (!query.ok) {
    throw new Error(`Managed bootstrap Docker incomplete-create discovery failed: ${query.error}`);
  }
  if (query.ids.length !== 1) {
    throw new Error(
      `Managed bootstrap incomplete-create cleanup requires exactly one labeled Docker workload; found ${String(
        query.ids.length,
      )}.`,
    );
  }
  const runtimeId = String(query.ids[0] ?? "").toLowerCase();
  const inspect = inspectExact(runtimeId, deps);
  const sandboxId = String(inspect.Config?.Labels?.[OPENSHELL_SANDBOX_ID_LABEL] ?? "");
  if (parseOpenShellSandboxId(`ID: ${sandboxId}\n`) !== sandboxId) {
    throw new Error(
      "Managed bootstrap Docker incomplete-create workload has no exact durable sandbox ID.",
    );
  }
  const sandbox = Object.freeze({
    sandboxName: input.plan.sandboxName,
    sandboxId,
    driverId: input.plan.driverId,
  });
  assertImage(inspect, input.plan.image, deps);
  assertMetadata(inspect, sandbox, input.plan.metadata);
  assertHeldCommand(inspect, input.heldWorkloadArgv, input.bootstrapIdentity);
  return { sandbox, runtimeId };
}

function managedSharedStateTransaction(
  handle: ManagedBootstrapHeldWorkloadHandle,
  containerId: string,
  image: string,
) {
  return {
    agent: handle.plan.profile.agent,
    bootstrapIdentity: handle.bootstrapIdentity,
    containerId,
    image,
    profileFingerprint: handle.plan.profile.fingerprint,
  } as const;
}

function reconstructDockerBootstrapTransaction(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
  replacement: ManagedBootstrapReplacementHandle,
): DockerBootstrapTransaction {
  if (
    replacement.bootstrapIdentity !== handle.bootstrapIdentity ||
    replacement.originalRuntimeId !== snapshot.runtimeId ||
    replacement.originalSpecHash !== snapshot.specHash ||
    replacement.replacementRuntimeId === replacement.originalRuntimeId
  ) {
    throw new Error(
      "Managed bootstrap finalization receipts do not reconstruct one exact Docker transaction.",
    );
  }
  const originalName = dockerContainerName(
    parseDockerManagedBootstrapLaunchSpec(snapshot.specCanonicalJson).inspect,
  );
  return Object.freeze({
    bootstrapIdentity: handle.bootstrapIdentity,
    originalRuntimeId: replacement.originalRuntimeId,
    replacementRuntimeId: replacement.replacementRuntimeId,
    originalName,
    backupName: backupName(originalName, handle.bootstrapIdentity),
    originalSpecHash: snapshot.specHash,
  });
}

function rollbackReplacementSharedStateIfPending(
  input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly replacementRuntimeId: string;
    readonly runtimeImageContentId: string;
  },
  deps: ResolvedDeps,
): void {
  if (!tryInspectExact(input.replacementRuntimeId, deps)) {
    throw new Error(
      "Managed bootstrap replacement disappeared before shared-state rollback could be proven; the preserved original remains stopped.",
    );
  }
  const transaction = managedSharedStateTransaction(
    input.handle,
    input.replacementRuntimeId,
    input.runtimeImageContentId,
  );
  finalizeDockerManagedStartupSharedState({ transaction, supervisorReady: false }, deps);
}

export function createDockerManagedBootstrapAdapter(
  dependencies: DockerManagedBootstrapDeps = {},
): DockerManagedBootstrapAdapter {
  const deps = resolveDeps(dependencies);
  const transactions = new Map<string, DockerBootstrapTransaction>();
  const committedTransactions = new Set<string>();
  const durablyCommittedTransactions = new Set<string>();
  const rollbackTombstones = new Map<string, DockerBootstrapRollbackTombstone>();
  const completedRollback = (
    handle: ManagedBootstrapHeldWorkloadHandle,
    alreadyRolledBack: boolean,
  ): ManagedBootstrapFinalizationReceipt => {
    const receipt = Object.freeze({
      schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      outcome: "rolled-back",
      restoredRuntimeId: null,
      restoredSpecHash: null,
      heldWorkloadRemoved: true,
      alreadyRolledBack,
      finalizedAt: deps.now().toISOString(),
    } satisfies ManagedBootstrapFinalizationReceipt);
    transactions.delete(handle.bootstrapIdentity);
    durablyCommittedTransactions.delete(handle.bootstrapIdentity);
    rollbackTombstones.set(handle.bootstrapIdentity, {
      profileFingerprint: handle.plan.profile.fingerprint,
      imageReference: expectedImageReference(
        handle.plan.image.repository,
        handle.plan.image.manifestDigest,
      ),
      receipt,
    });
    return receipt;
  };
  const priorRollback = (
    handle: ManagedBootstrapHeldWorkloadHandle,
  ): ManagedBootstrapFinalizationReceipt | null => {
    const tombstone = rollbackTombstones.get(handle.bootstrapIdentity);
    if (!tombstone) return null;
    const receipt = tombstone.receipt;
    if (
      receipt.sandbox.sandboxName !== handle.sandbox.sandboxName ||
      receipt.sandbox.sandboxId !== handle.sandbox.sandboxId ||
      receipt.sandbox.driverId !== handle.sandbox.driverId ||
      tombstone.profileFingerprint !== handle.plan.profile.fingerprint ||
      tombstone.imageReference !==
        expectedImageReference(handle.plan.image.repository, handle.plan.image.manifestDigest)
    ) {
      throw new Error("Managed bootstrap rollback tombstone does not match its durable identity.");
    }
    return Object.freeze({
      ...receipt,
      alreadyRolledBack: true,
    });
  };
  const rollbackBootstrapNow = ({
    handle,
    snapshot,
    replacement,
    sharedStateAlreadyRolledBack = false,
  }: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot | null;
    readonly replacement: ManagedBootstrapReplacementHandle | null;
    readonly sharedStateAlreadyRolledBack?: boolean;
  }): ManagedBootstrapFinalizationReceipt => {
    const finalized = priorRollback(handle);
    if (finalized) return finalized;
    if (committedTransactions.has(handle.bootstrapIdentity)) {
      throw new ManagedBootstrapDurableCommitCleanupPendingError({
        bootstrapIdentity: handle.bootstrapIdentity,
        cleanupRuntimeId: snapshot?.runtimeId ?? "unknown",
        detail: "rollback is no longer legal after completed managed-bootstrap commit",
      });
    }
    if (snapshot && replacement) {
      const reconstructed = reconstructDockerBootstrapTransaction(handle, snapshot, replacement);
      const replacementStatus = probeExactDockerContainerAbsence(
        reconstructed.replacementRuntimeId,
        deps,
      );
      const originalStatus = probeExactDockerContainerAbsence(
        reconstructed.originalRuntimeId,
        deps,
      );
      if (replacementStatus === "unknown" || originalStatus === "unknown") {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: handle.bootstrapIdentity,
          runtimeId:
            replacementStatus === "unknown"
              ? reconstructed.replacementRuntimeId
              : reconstructed.originalRuntimeId,
          detail:
            "exact rollback runtime presence could not be proven before any destructive mutation",
        });
      }
      if (replacementStatus === "absent" && originalStatus === "present") {
        const original = inspectExact(reconstructed.originalRuntimeId, deps);
        const originalName = dockerContainerName(original);
        const normalizedOriginal = normalizeDockerManagedBootstrapLaunchSpec({
          ...original,
          Name: `/${reconstructed.originalName}`,
        });
        if (normalizedOriginal.hash !== reconstructed.originalSpecHash) {
          throw new Error(
            "Managed bootstrap refused recovery because the exact original launch spec changed.",
          );
        }
        if (originalName === reconstructed.originalName) {
          removeOwnedWorkload(handle.sandbox, deps, reconstructed.originalRuntimeId);
        }
        if (originalName !== reconstructed.backupName || !sharedStateAlreadyRolledBack) {
          throw new ManagedBootstrapCommitStateIndeterminateError({
            bootstrapIdentity: handle.bootstrapIdentity,
            runtimeId: reconstructed.originalRuntimeId,
            detail:
              "the replacement is absent, but completed shared-state rollback and exact original restoration were not both proven",
          });
        }
        restoreOriginal(reconstructed, deps);
        removeOwnedWorkload(handle.sandbox, deps, reconstructed.originalRuntimeId);
      }
      if (replacementStatus === "absent" && originalStatus === "absent") {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: handle.bootstrapIdentity,
          runtimeId: reconstructed.replacementRuntimeId,
          detail: "both exact rollback runtimes are absent",
        });
      }
    }
    if (replacement && !durablyCommittedTransactions.has(handle.bootstrapIdentity)) {
      const sharedStatus = probeDockerManagedStartupSharedState(
        {
          transaction: managedSharedStateTransaction(
            handle,
            replacement.replacementRuntimeId,
            replacement.runtimeImageContentId,
          ),
          profileFingerprint: handle.plan.profile.fingerprint,
        },
        deps,
      );
      if (sharedStatus === "committed") {
        durablyCommittedTransactions.add(handle.bootstrapIdentity);
      } else if (snapshot) {
        const reconstructed = reconstructDockerBootstrapTransaction(handle, snapshot, replacement);
        const originalStatus = probeExactDockerContainerAbsence(
          reconstructed.originalRuntimeId,
          deps,
        );
        if (originalStatus === "absent") {
          if (sharedStatus === "pending") {
            throw new ManagedBootstrapCommitStateIndeterminateError({
              bootstrapIdentity: handle.bootstrapIdentity,
              runtimeId: reconstructed.originalRuntimeId,
              detail:
                "the shared-state receipt is pending, but the exact rollback backup is absent",
            });
          }
          committedTransactions.add(handle.bootstrapIdentity);
          throw new ManagedBootstrapDurableCommitCleanupPendingError({
            bootstrapIdentity: handle.bootstrapIdentity,
            cleanupRuntimeId: reconstructed.originalRuntimeId,
            detail:
              "rollback is no longer legal after the exact rollback backup and durable commit receipt were retired",
          });
        }
        if (originalStatus === "unknown") {
          throw new ManagedBootstrapCommitStateIndeterminateError({
            bootstrapIdentity: handle.bootstrapIdentity,
            runtimeId: reconstructed.originalRuntimeId,
            detail:
              "the exact rollback-backup identity could not be proven present; no rollback mutation was attempted",
          });
        }
        let original: DockerContainerInspect;
        try {
          original = inspectExact(reconstructed.originalRuntimeId, deps);
        } catch (error) {
          throw new ManagedBootstrapCommitStateIndeterminateError({
            bootstrapIdentity: handle.bootstrapIdentity,
            runtimeId: reconstructed.originalRuntimeId,
            detail: `the exact rollback backup became unavailable during verification: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
        if (dockerContainerName(original) !== reconstructed.backupName) {
          throw new Error(
            "Managed bootstrap refused rollback because the exact original is not held under its transaction backup name.",
          );
        }
        const normalizedOriginal = normalizeDockerManagedBootstrapLaunchSpec({
          ...original,
          Name: `/${reconstructed.originalName}`,
        });
        if (normalizedOriginal.hash !== reconstructed.originalSpecHash) {
          throw new Error(
            "Managed bootstrap refused rollback because the exact original backup launch spec changed.",
          );
        }
      }
    }
    if (durablyCommittedTransactions.has(handle.bootstrapIdentity)) {
      const transaction =
        transactions.get(handle.bootstrapIdentity) ??
        (snapshot && replacement
          ? reconstructDockerBootstrapTransaction(handle, snapshot, replacement)
          : null);
      throw new ManagedBootstrapDurableCommitCleanupPendingError({
        bootstrapIdentity: handle.bootstrapIdentity,
        cleanupRuntimeId: transaction?.originalRuntimeId ?? snapshot?.runtimeId ?? "unknown",
        detail:
          "rollback is no longer legal after durable shared-state commit; retry commit finalization",
      });
    }
    if (!snapshot) {
      removeOwnedWorkload(handle.sandbox, deps);
      return completedRollback(handle, false);
    }
    const existing = transactions.get(handle.bootstrapIdentity);
    const originalName = dockerContainerName(
      parseDockerManagedBootstrapLaunchSpec(snapshot.specCanonicalJson).inspect,
    );
    const transaction: DockerBootstrapTransaction =
      existing ??
      Object.freeze({
        bootstrapIdentity: handle.bootstrapIdentity,
        originalRuntimeId: snapshot.runtimeId,
        replacementRuntimeId: replacement?.replacementRuntimeId ?? "0".repeat(64),
        originalName,
        backupName: backupName(originalName, handle.bootstrapIdentity),
        originalSpecHash: snapshot.specHash,
      });
    const currentOriginal = tryInspectExact(transaction.originalRuntimeId, deps);
    const alreadyRolledBack =
      currentOriginal !== null &&
      dockerContainerName(currentOriginal) === transaction.originalName &&
      currentOriginal.State?.Running === true &&
      tryInspectExact(transaction.replacementRuntimeId, deps) === null;
    if (!alreadyRolledBack) {
      if (replacement) {
        rollbackReplacementSharedStateIfPending(
          {
            handle,
            replacementRuntimeId: replacement.replacementRuntimeId,
            runtimeImageContentId: replacement.runtimeImageContentId,
          },
          deps,
        );
      }
      restoreOriginal(transaction, deps);
    }
    const restored = inspectExact(transaction.originalRuntimeId, deps);
    const restoredSpec = normalizeDockerManagedBootstrapLaunchSpec(restored);
    if (restoredSpec.hash !== snapshot.specHash) {
      throw new Error("Managed bootstrap Docker rollback receipt spec does not match.");
    }
    removeOwnedWorkload(handle.sandbox, deps, transaction.originalRuntimeId);
    return completedRollback(handle, alreadyRolledBack);
  };
  const commitBootstrapNow = (
    receipt: ManagedBootstrapCompletionReceipt,
    expectedTransaction: DockerBootstrapTransaction,
    input: {
      readonly durableSharedCommit: boolean;
      readonly sharedStateTransaction: ReturnType<typeof managedSharedStateTransaction>;
    },
  ): void => {
    if (committedTransactions.has(receipt.bootstrapIdentity)) return;
    const transaction = transactions.get(receipt.bootstrapIdentity) ?? expectedTransaction;
    if (
      transaction.bootstrapIdentity !== expectedTransaction.bootstrapIdentity ||
      transaction.originalRuntimeId !== expectedTransaction.originalRuntimeId ||
      transaction.replacementRuntimeId !== expectedTransaction.replacementRuntimeId ||
      transaction.originalName !== expectedTransaction.originalName ||
      transaction.backupName !== expectedTransaction.backupName ||
      transaction.originalSpecHash !== expectedTransaction.originalSpecHash ||
      transaction.replacementRuntimeId !== receipt.runtimeId ||
      transaction.originalSpecHash !== receipt.originalSpecHash
    ) {
      throw new Error("Managed bootstrap Docker commit receipt does not match its transaction.");
    }
    const removed = deps.dockerRm(transaction.originalRuntimeId, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (!hasZeroDockerExitStatus(removed)) {
      const absence = probeExactDockerContainerAbsence(transaction.originalRuntimeId, deps);
      if (absence !== "absent") {
        const detail =
          absence === "present"
            ? "exact rollback backup still exists"
            : "exact rollback-backup absence was not proven";
        if (!input.durableSharedCommit) {
          throw new Error(
            `Managed bootstrap rollback-backup cleanup failed before a durable shared-state commit: ${
              commandDetail(removed) || "Docker removal failed"
            }; ${detail}`,
          );
        }
        throw new ManagedBootstrapDurableCommitCleanupPendingError({
          bootstrapIdentity: receipt.bootstrapIdentity,
          cleanupRuntimeId: transaction.originalRuntimeId,
          detail: `${commandDetail(removed) || "Docker removal failed"}; ${detail}`,
        });
      }
    }
    if (input.durableSharedCommit) {
      try {
        clearDockerManagedStartupSharedStateCommitReceipt(input.sharedStateTransaction, deps);
      } catch (error) {
        throw new ManagedBootstrapDurableCommitCleanupPendingError({
          bootstrapIdentity: receipt.bootstrapIdentity,
          cleanupRuntimeId: transaction.replacementRuntimeId,
          detail: `exact rollback backup is absent, but its image-owned commit receipt could not be retired: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    transactions.delete(receipt.bootstrapIdentity);
    durablyCommittedTransactions.delete(receipt.bootstrapIdentity);
    committedTransactions.add(receipt.bootstrapIdentity);
  };
  const finalizeBootstrap = async (
    input: Parameters<ManagedBootstrapAdapter["finalizeBootstrap"]>[0],
  ): Promise<ManagedBootstrapFinalizationReceipt> => {
    if (input.outcome === "rollback") {
      return rollbackBootstrapNow(input);
    }
    const { completion, handle, replacement, snapshot } = input;
    if (!completion || !snapshot || !replacement) {
      throw new Error("Managed bootstrap commit requires one complete cutover receipt.");
    }
    const transaction = managedSharedStateTransaction(
      handle,
      replacement.replacementRuntimeId,
      replacement.runtimeImageContentId,
    );
    const sharedStatus = probeDockerManagedStartupSharedState(
      {
        transaction,
        profileFingerprint: completion.profileFingerprint,
      },
      deps,
    );
    const expectedTransaction = reconstructDockerBootstrapTransaction(
      handle,
      snapshot,
      replacement,
    );
    if (!completion.transactionPending && sharedStatus !== "none") {
      throw new Error(
        "Managed bootstrap image completion disagrees with shared-state transaction status.",
      );
    }
    if (completion.transactionPending && sharedStatus === "none") {
      const originalAbsence = probeExactDockerContainerAbsence(
        expectedTransaction.originalRuntimeId,
        deps,
      );
      if (originalAbsence !== "absent") {
        throw new Error(
          "Managed bootstrap image completion lost its shared-state commit receipt before exact rollback-backup removal was proven.",
        );
      }
      committedTransactions.add(completion.bootstrapIdentity);
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        outcome: "committed",
        restoredRuntimeId: null,
        restoredSpecHash: null,
        heldWorkloadRemoved: false,
        alreadyRolledBack: false,
        finalizedAt: deps.now().toISOString(),
      });
    }
    const durableCommitRecorded =
      sharedStatus === "committed" ||
      durablyCommittedTransactions.has(completion.bootstrapIdentity);
    if (sharedStatus === "committed") {
      durablyCommittedTransactions.add(completion.bootstrapIdentity);
    }
    if (sharedStatus === "pending") {
      if (durableCommitRecorded) {
        throw new Error(
          "Managed bootstrap shared-state transaction reappeared after durable commit.",
        );
      }
      let outcome;
      try {
        outcome = finalizeDockerManagedStartupSharedState(
          { transaction, supervisorReady: true },
          deps,
        );
      } catch (error) {
        if (error instanceof DockerManagedStartupSharedStateCommitIndeterminateError) {
          throw new ManagedBootstrapCommitStateIndeterminateError({
            bootstrapIdentity: completion.bootstrapIdentity,
            runtimeId: replacement.replacementRuntimeId,
            detail: error.message,
          });
        }
        throw error;
      }
      if (!outcome.supervisorReady) {
        const failure =
          outcome.failure ?? new Error("Managed bootstrap shared-state commit did not complete.");
        let restored: ManagedBootstrapFinalizationReceipt;
        try {
          restored = rollbackBootstrapNow({
            handle,
            snapshot,
            replacement,
            sharedStateAlreadyRolledBack: true,
          });
        } catch (rollbackError) {
          attachManagedBootstrapRollbackError(failure, rollbackError);
          throw failure;
        }
        (
          failure as Error & {
            managedBootstrapRollback?: ManagedBootstrapFinalizationReceipt;
          }
        ).managedBootstrapRollback = restored;
        throw failure;
      }
      durablyCommittedTransactions.add(completion.bootstrapIdentity);
    }
    commitBootstrapNow(completion, expectedTransaction, {
      durableSharedCommit:
        completion.transactionPending &&
        (sharedStatus === "committed" ||
          durablyCommittedTransactions.has(completion.bootstrapIdentity)),
      sharedStateTransaction: transaction,
    });
    return Object.freeze({
      schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      outcome: "committed",
      restoredRuntimeId: null,
      restoredSpecHash: null,
      heldWorkloadRemoved: false,
      alreadyRolledBack: false,
      finalizedAt: deps.now().toISOString(),
    });
  };

  return {
    async createHeldWorkload(input) {
      if (
        input.plan.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
        input.plan.driverId !== DOCKER_DRIVER_ID ||
        input.request.agent !== input.plan.profile.agent ||
        input.request.profileFingerprint !== input.plan.profile.fingerprint
      ) {
        throw new Error("Managed bootstrap Docker create plan does not match its root request.");
      }
      const bootstrapIdentity = input.bootstrapIdentity ?? deps.createBootstrapIdentity();
      assertManagedBootstrapIdentity(bootstrapIdentity);
      const heldWorkloadArgv = renderManagedBootstrapHeldCommand(
        input.request,
        bootstrapIdentity,
        input.plan.intendedWorkloadArgv,
      );
      const createReceipt = await input.launch({ heldWorkloadArgv, bootstrapIdentity });
      if (
        createReceipt.ready !== true ||
        createReceipt.sandbox.sandboxName !== input.plan.sandboxName ||
        createReceipt.sandbox.driverId !== input.plan.driverId ||
        !createReceipt.sandbox.sandboxId
      ) {
        throw new Error(
          "Managed bootstrap Docker create did not return one Ready durable sandbox identity.",
        );
      }
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: Object.freeze({ ...createReceipt.sandbox }),
        bootstrapIdentity,
        heldWorkloadArgv,
        intendedWorkloadArgv: Object.freeze([...input.plan.intendedWorkloadArgv]),
        plan: input.plan,
        createReceipt,
      });
    },

    async cleanupIncompleteCreate(input) {
      const { sandbox, runtimeId } = resolveIncompleteCreateSandbox(input, deps);
      removeOwnedWorkload(sandbox, deps, runtimeId);
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox,
        bootstrapIdentity: input.bootstrapIdentity,
        outcome: "rolled-back",
        restoredRuntimeId: null,
        restoredSpecHash: null,
        heldWorkloadRemoved: true,
        alreadyRolledBack: false,
        finalizedAt: deps.now().toISOString(),
      });
    },

    async discoverHeldWorkload(
      input: ManagedBootstrapDiscoveryInput,
    ): Promise<ManagedBootstrapDiscoveredWorkload> {
      if (input.sandbox.driverId !== DOCKER_DRIVER_ID) {
        throw new Error("Managed bootstrap Docker adapter received another runtime driver.");
      }
      const query = queryOpenShellDockerSandboxContainers(input.sandbox.sandboxName, deps);
      if (!query.ok) {
        throw new Error(`Managed bootstrap Docker discovery failed: ${query.error}`);
      }
      if (query.ids.length !== 1) {
        throw new Error(
          `Managed bootstrap requires exactly one labeled Docker workload after Ready; found ${String(
            query.ids.length,
          )}.`,
        );
      }
      const runtimeId = String(query.ids[0] ?? "").toLowerCase();
      const inspect = inspectExact(runtimeId, deps);
      assertStableRunning(inspect, "held workload");
      assertRootSupervisor(inspect);
      assertImage(inspect, input.expectedImage, deps);
      assertMetadata(inspect, input.sandbox, input.metadata);
      assertBootstrapIdentityInObservedHold(inspect, input.bootstrapIdentity);
      return Object.freeze({
        sandbox: input.sandbox,
        runtimeId,
        bootstrapIdentity: input.bootstrapIdentity,
      });
    },

    async inspectHeldWorkload({ handle, discovered }) {
      if (
        discovered.bootstrapIdentity !== handle.bootstrapIdentity ||
        discovered.sandbox.sandboxId !== handle.sandbox.sandboxId ||
        discovered.sandbox.driverId !== handle.sandbox.driverId
      ) {
        throw new Error("Managed bootstrap Docker identity changed before inspection.");
      }
      const first = inspectExact(discovered.runtimeId, deps);
      assertStableRunning(first, "held workload");
      assertRootSupervisor(first);
      assertNoRootProcessInjectionEnvironment(first.Config?.Env);
      const runtimeImageContentId = assertImage(first, handle.plan.image, deps);
      assertMetadata(first, handle.sandbox, handle.plan.metadata);
      assertHeldCommand(first, handle.heldWorkloadArgv, handle.bootstrapIdentity);
      const firstNormalized = normalizeDockerManagedBootstrapLaunchSpec(first);
      const inspect = inspectExact(discovered.runtimeId, deps);
      assertStableRunning(inspect, "held workload");
      assertRootSupervisor(inspect);
      assertNoRootProcessInjectionEnvironment(inspect.Config?.Env);
      if (assertImage(inspect, handle.plan.image, deps) !== runtimeImageContentId) {
        throw new Error("Managed bootstrap Docker image content changed during stable capture.");
      }
      assertMetadata(inspect, handle.sandbox, handle.plan.metadata);
      assertHeldCommand(inspect, handle.heldWorkloadArgv, handle.bootstrapIdentity);
      const normalized = normalizeDockerManagedBootstrapLaunchSpec(inspect);
      if (
        normalized.hash !== firstNormalized.hash ||
        normalized.canonicalJson !== firstNormalized.canonicalJson
      ) {
        throw new Error("Managed bootstrap Docker launch spec changed during stable capture.");
      }
      const supervisorArgv = exactSupervisorArgv(inspect);
      if (!exactArrayEqual(supervisorArgv, handle.plan.expectedSupervisorArgv)) {
        throw new Error("Managed bootstrap Docker supervisor argv changed before replacement.");
      }
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        runtimeId: discovered.runtimeId,
        bootstrapIdentity: handle.bootstrapIdentity,
        image: handle.plan.image,
        runtimeImageContentId,
        specHash: normalized.hash,
        specCanonicalJson: normalized.canonicalJson,
        agentIdentity: Object.freeze({ ...handle.plan.agentIdentity }),
        supervisorArgv,
        heldWorkloadArgv: handle.heldWorkloadArgv,
        metadata: handle.plan.metadata,
      });
    },

    async replaceForBootstrap({ handle, snapshot, request, replacementOptions }) {
      if (
        snapshot.bootstrapIdentity !== handle.bootstrapIdentity ||
        snapshot.runtimeId.length !== 64 ||
        request.agent !== handle.plan.profile.agent ||
        request.profileFingerprint !== handle.plan.profile.fingerprint
      ) {
        throw new Error("Managed bootstrap Docker replacement identities do not match.");
      }
      const parsed = parseDockerManagedBootstrapLaunchSpec(snapshot.specCanonicalJson);
      const normalizedOriginal = normalizeDockerManagedBootstrapLaunchSpec(parsed.inspect);
      if (normalizedOriginal.hash !== snapshot.specHash) {
        throw new Error("Managed bootstrap Docker replacement snapshot is not exact.");
      }
      if (parsed.inspect.HostConfig?.ReadonlyRootfs === true) {
        throw new Error(
          "Managed bootstrap cannot stage its root-owned request in a read-only root filesystem.",
        );
      }
      const plan = replacementPlan(replacementOptions);
      const originalName = dockerContainerName(parsed.inspect);
      const backupContainerName = backupName(originalName, handle.bootstrapIdentity);
      const trampolineCommand = replacementCommand(handle, snapshot);
      const cloneArgs = buildDockerGpuCloneRunArgs(parsed.inspect, plan.mode, {
        image: expectedImageReference(snapshot.image.repository, snapshot.image.manifestDigest),
        openshellSandboxCommand: handle.intendedWorkloadArgv,
        requiredUlimits: plan.requiredUlimits,
        extraGroupGids: plan.extraGroupGids,
        containerEntrypoint: MANAGED_BOOTSTRAP_TRAMPOLINE_EXECUTABLE,
        containerCommand: trampolineCommand,
      });
      const options = {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      };
      assertZero(
        deps.dockerStop(snapshot.runtimeId, {
          ...options,
          timeout: DOCKER_GPU_PATCH_STOP_TIMEOUT_MS,
        }),
        "Managed bootstrap could not stop the held Docker workload",
      );
      const renamed = deps.dockerRename(snapshot.runtimeId, backupContainerName, options);
      if (!hasZeroDockerExitStatus(renamed)) {
        deps.dockerStart(snapshot.runtimeId, options);
        throw new Error(
          `Managed bootstrap could not preserve the held Docker workload: ${commandDetail(renamed)}`,
        );
      }

      let requestFile = "";
      let replacementRuntimeId = "";
      try {
        const created = deps.dockerRun(["create", ...cloneArgs], options);
        assertZero(created, "Managed bootstrap could not create the Docker replacement");
        replacementRuntimeId = String(created.stdout ?? "")
          .trim()
          .toLowerCase();
        if (!FULL_CONTAINER_ID_RE.test(replacementRuntimeId)) {
          throw new Error("Managed bootstrap Docker create did not return one full container ID.");
        }
        const createdInspect = inspectExact(replacementRuntimeId, deps);
        if (createdInspect.State?.Running === true) {
          throw new Error("Managed bootstrap replacement started before request validation.");
        }
        const createdImageContentId = assertImage(createdInspect, snapshot.image, deps);
        if (createdImageContentId !== snapshot.runtimeImageContentId) {
          throw new Error(
            "Managed bootstrap Docker replacement resolved a different image content ID.",
          );
        }
        assertMetadata(createdInspect, handle.sandbox, snapshot.metadata);
        assertRootSupervisor(createdInspect);
        assertReplacementBoundary(createdInspect, handle, snapshot);
        const intendedReplacementSpecHash = assertReplacementMatchesIntent(
          snapshot.specCanonicalJson,
          createdInspect,
          plan,
          openshellSandboxCommandEnvValue(handle.intendedWorkloadArgv) as string,
        );

        requestFile = writeProtectedEnvelope(handle.bootstrapIdentity, request);
        const copied = deps.dockerRun(
          ["cp", requestFile, `${replacementRuntimeId}:${MANAGED_BOOTSTRAP_REQUEST_FILE}`],
          options,
        );
        assertZero(
          copied,
          "Managed bootstrap could not stage its protected root-owned 0400 envelope",
        );
        assertZero(
          deps.dockerStart(replacementRuntimeId, options),
          "Managed bootstrap could not start the Docker replacement",
        );
        const running = inspectExact(replacementRuntimeId, deps);
        assertStableRunning(running, "replacement");
        assertReplacementBoundary(running, handle, snapshot);
        const replacementSpecHash = assertReplacementMatchesIntent(
          snapshot.specCanonicalJson,
          running,
          plan,
          openshellSandboxCommandEnvValue(handle.intendedWorkloadArgv) as string,
        );
        if (replacementSpecHash !== intendedReplacementSpecHash) {
          throw new Error("Managed bootstrap Docker replacement changed between create and start.");
        }
        const transaction: DockerBootstrapTransaction = Object.freeze({
          bootstrapIdentity: handle.bootstrapIdentity,
          originalRuntimeId: snapshot.runtimeId,
          replacementRuntimeId,
          originalName,
          backupName: backupContainerName,
          originalSpecHash: snapshot.specHash,
        });
        transactions.set(handle.bootstrapIdentity, transaction);
        return Object.freeze({
          schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
          sandbox: handle.sandbox,
          bootstrapIdentity: handle.bootstrapIdentity,
          originalRuntimeId: snapshot.runtimeId,
          replacementRuntimeId,
          image: snapshot.image,
          runtimeImageContentId: snapshot.runtimeImageContentId,
          originalSpecHash: snapshot.specHash,
          replacementSpecHash,
          profileFingerprint: handle.plan.profile.fingerprint,
        });
      } catch (error) {
        const partial: DockerBootstrapTransaction = {
          bootstrapIdentity: handle.bootstrapIdentity,
          originalRuntimeId: snapshot.runtimeId,
          replacementRuntimeId: FULL_CONTAINER_ID_RE.test(replacementRuntimeId)
            ? replacementRuntimeId
            : "0".repeat(64),
          originalName,
          backupName: backupContainerName,
          originalSpecHash: snapshot.specHash,
        };
        try {
          if (FULL_CONTAINER_ID_RE.test(replacementRuntimeId)) {
            rollbackReplacementSharedStateIfPending(
              {
                handle,
                replacementRuntimeId,
                runtimeImageContentId: snapshot.runtimeImageContentId,
              },
              deps,
            );
          }
          restoreOriginal(partial, deps);
        } catch (rollbackError) {
          const failure = error instanceof Error ? error : new Error(String(error));
          attachManagedBootstrapRollbackError(failure, rollbackError);
          throw failure;
        }
        throw error;
      } finally {
        if (requestFile) cleanupTempDir(requestFile, REQUEST_TEMP_PREFIX);
      }
    },

    async awaitBootstrap({ handle, snapshot, replacement, timeoutSecs }) {
      if (
        replacement.bootstrapIdentity !== handle.bootstrapIdentity ||
        replacement.originalRuntimeId !== snapshot.runtimeId ||
        replacement.profileFingerprint !== handle.plan.profile.fingerprint
      ) {
        throw new Error("Managed bootstrap Docker completion identities do not match.");
      }
      const before = inspectExact(replacement.replacementRuntimeId, deps);
      assertStableRunning(before, "replacement");
      const beforeImageContentId = assertImage(before, replacement.image, deps);
      if (beforeImageContentId !== replacement.runtimeImageContentId) {
        throw new Error("Managed bootstrap Docker replacement image content changed.");
      }
      assertReplacementBoundary(before, handle, snapshot);
      if (!waitForOpenShellSupervisorReconnect(handle.sandbox.sandboxName, timeoutSecs, deps)) {
        throw new Error("Managed bootstrap Docker supervisor did not reconnect.");
      }
      const after = inspectExact(replacement.replacementRuntimeId, deps);
      assertStableRunning(after, "completed replacement");
      if (assertImage(after, replacement.image, deps) !== replacement.runtimeImageContentId) {
        throw new Error("Managed bootstrap Docker completed image content changed.");
      }
      assertReplacementBoundary(after, handle, snapshot);
      const normalized = normalizeDockerManagedBootstrapLaunchSpec(after);
      if (normalized.hash !== replacement.replacementSpecHash) {
        throw new Error("Managed bootstrap Docker replacement changed during bootstrap.");
      }
      const imageCompletion = readProtectedImageCompletion(replacement.replacementRuntimeId, deps);
      if (
        imageCompletion.bootstrapIdentity !== replacement.bootstrapIdentity ||
        imageCompletion.agent !== handle.plan.profile.agent ||
        imageCompletion.profileFingerprint !== replacement.profileFingerprint
      ) {
        throw new Error(
          "Managed bootstrap Docker image completion identities do not match the transaction.",
        );
      }
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        runtimeId: replacement.replacementRuntimeId,
        image: replacement.image,
        runtimeImageContentId: replacement.runtimeImageContentId,
        originalSpecHash: replacement.originalSpecHash,
        replacementSpecHash: replacement.replacementSpecHash,
        profileFingerprint: replacement.profileFingerprint,
        bootstrapIdentity: replacement.bootstrapIdentity,
        transactionPending: imageCompletion.transactionPending,
        completedAt: deps.now().toISOString(),
      });
    },

    finalizeBootstrap,
  };
}
