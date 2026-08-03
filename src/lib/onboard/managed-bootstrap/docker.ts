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
  createManagedBootstrapPlanFingerprint,
  createManagedBootstrapPreparedAuthority,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapAdapter,
  ManagedBootstrapCommitStateIndeterminateError,
  type ManagedBootstrapCompletionReceipt,
  type ManagedBootstrapDiscoveredWorkload,
  type ManagedBootstrapDiscoveryInput,
  ManagedBootstrapDurableCommitCleanupPendingError,
  type ManagedBootstrapDurablePreparationReceipt,
  type ManagedBootstrapFinalizationReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  type ManagedBootstrapIncompleteCreateCleanupInput,
  type ManagedBootstrapObservedSnapshot,
  ManagedBootstrapOwnerCleanupRequiredError,
  type ManagedBootstrapPreparedReplacementHandle,
  type ManagedBootstrapReplacementHandle,
  type ManagedBootstrapReplacementOptions,
  type ManagedBootstrapSandboxIdentity,
  renderManagedBootstrapHeldCommand,
} from "./adapter";
import {
  createFileDockerManagedBootstrapJournalStore,
  DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION,
  DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  type DockerManagedBootstrapFinalizationRecord,
  type DockerManagedBootstrapJournal,
  DockerManagedBootstrapJournalAcknowledgementLostError,
  type DockerManagedBootstrapJournalStore,
  parseDockerManagedBootstrapJournal,
  sameDockerManagedBootstrapReceipt,
  serializeDockerManagedBootstrapFinalizationRecord,
  serializeDockerManagedBootstrapJournal,
} from "./docker-journal";
import {
  clearDockerManagedStartupSharedStateCommitReceipt,
  DockerManagedStartupSharedStateCommitIndeterminateError,
  finalizeDockerManagedStartupSharedState,
  probeDockerManagedStartupSharedState,
} from "./docker-shared-state";
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
  readonly journalStore?: DockerManagedBootstrapJournalStore;
  /** Canonical gateway-scoped state root; required when no store is injected. */
  readonly stateRoot?: string;
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
    | "journalStore"
    | "now"
    | "createBootstrapIdentity"
  >
> &
  DockerManagedBootstrapDeps;

type DockerBootstrapTransaction = DockerManagedBootstrapJournal;

export interface DockerManagedBootstrapAdapter extends ManagedBootstrapAdapter {}

function resolveDeps(deps: DockerManagedBootstrapDeps): ResolvedDeps {
  const journalStore =
    deps.journalStore ??
    (deps.stateRoot ? createFileDockerManagedBootstrapJournalStore(deps.stateRoot) : null);
  if (!journalStore) {
    throw new Error(
      "Managed bootstrap Docker requires its canonical state root or an injected journal store.",
    );
  }
  return {
    dockerCapture: defaultDockerCapture,
    dockerRename: defaultDockerRename,
    dockerRm: defaultDockerRm,
    dockerRun: defaultDockerRun,
    dockerStart: defaultDockerStart,
    dockerStop: defaultDockerStop,
    journalStore,
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

function isStableRunning(inspect: DockerContainerInspect): boolean {
  return inspect.State?.Running !== true ||
    inspect.State.Paused === true ||
    inspect.State.Restarting === true ||
    inspect.State.Dead === true
    ? false
    : true;
}

function assertStableRunning(inspect: DockerContainerInspect, label: string): void {
  if (!isStableRunning(inspect)) {
    throw new Error(`Managed bootstrap Docker ${label} is not stably running.`);
  }
}

function isExplicitlyStopped(inspect: DockerContainerInspect): boolean {
  return (
    inspect.State?.Running === false &&
    inspect.State.Paused === false &&
    inspect.State.Restarting === false &&
    inspect.State.Dead === false
  );
}

function assertExplicitlyStopped(inspect: DockerContainerInspect, label: string): void {
  if (!isExplicitlyStopped(inspect)) {
    throw new Error(`Managed bootstrap Docker ${label} is not explicitly stopped.`);
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

function inspectDockerContainerReference(
  reference: string,
  deps: ResolvedDeps,
): DockerContainerInspect {
  if (
    reference.length === 0 ||
    reference !== reference.trim() ||
    reference.includes("\0") ||
    Buffer.byteLength(reference, "utf8") > MAX_CONTAINER_NAME_LENGTH
  ) {
    throw new Error("Managed bootstrap Docker lookup reference is invalid.");
  }
  const output = deps.dockerCapture(["inspect", "--type", "container", reference], {
    ignoreError: false,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  });
  const inspect = parseExactDockerContainerInspect(output);
  const runtimeId = String(inspect.Id ?? "").toLowerCase();
  if (!FULL_CONTAINER_ID_RE.test(runtimeId)) {
    throw new Error("Managed bootstrap Docker lookup did not resolve one full runtime ID.");
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

function replacementStagingName(originalName: string, bootstrapIdentity: string): string {
  const suffix = `-nemoclaw-staged-${bootstrapIdentity.slice(0, 20)}`;
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
  authoritativeName: string,
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
  const replacementSpec = normalizeDockerManagedBootstrapLaunchSpec({
    ...replacement,
    Name: `/${authoritativeName}`,
  });
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

function inspectTransactionRuntime(
  transaction: DockerBootstrapTransaction,
  runtimeId: string,
  deps: ResolvedDeps,
): DockerContainerInspect | null {
  const presence = probeExactDockerContainerAbsence(runtimeId, deps);
  if (presence === "unknown") {
    throw new ManagedBootstrapCommitStateIndeterminateError({
      bootstrapIdentity: transaction.bootstrapIdentity,
      runtimeId,
      detail: "exact Docker runtime presence could not be proven before mutation",
    });
  }
  if (presence === "absent") return null;
  try {
    return inspectExact(runtimeId, deps);
  } catch (error) {
    throw new ManagedBootstrapCommitStateIndeterminateError({
      bootstrapIdentity: transaction.bootstrapIdentity,
      runtimeId,
      detail: `exact Docker runtime inspection became unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

function assertTransactionOriginal(
  transaction: DockerBootstrapTransaction,
  inspect: DockerContainerInspect,
): void {
  const name = dockerContainerName(inspect);
  if (name !== transaction.originalName && name !== transaction.backupName) {
    throw new Error("Managed bootstrap original container has an unexpected transaction name.");
  }
  const normalized = normalizeDockerManagedBootstrapLaunchSpec({
    ...inspect,
    Name: `/${transaction.originalName}`,
  });
  if (normalized.hash !== transaction.originalSpecHash) {
    throw new Error(
      "Managed bootstrap refused mutation because the exact original launch spec changed.",
    );
  }
}

function assertTransactionReplacement(
  transaction: DockerBootstrapTransaction,
  inspect: DockerContainerInspect,
): void {
  const name = dockerContainerName(inspect);
  if (name !== transaction.replacementStagingName && name !== transaction.originalName) {
    throw new Error("Managed bootstrap replacement container has an unexpected transaction name.");
  }
  const normalized = normalizeDockerManagedBootstrapLaunchSpec({
    ...inspect,
    Name: `/${transaction.originalName}`,
  });
  if (normalized.hash !== transaction.replacementSpecHash) {
    throw new Error(
      "Managed bootstrap refused mutation because the exact replacement launch spec changed.",
    );
  }
}

function assertCompletedCutoverRuntimeState(
  transaction: DockerBootstrapTransaction,
  deps: ResolvedDeps,
): void {
  const original = inspectTransactionRuntime(transaction, transaction.originalRuntimeId, deps);
  const replacement = inspectTransactionRuntime(
    transaction,
    transaction.replacementRuntimeId,
    deps,
  );
  if (!original || !replacement) {
    throw new ManagedBootstrapCommitStateIndeterminateError({
      bootstrapIdentity: transaction.bootstrapIdentity,
      runtimeId: original ? transaction.replacementRuntimeId : transaction.originalRuntimeId,
      detail: "completed cutover requires both exact transaction runtimes",
    });
  }
  assertTransactionOriginal(transaction, original);
  assertTransactionReplacement(transaction, replacement);
  assertExplicitlyStopped(original, "rollback backup");
  assertStableRunning(replacement, "replacement");
  if (
    dockerContainerName(original) !== transaction.backupName ||
    dockerContainerName(replacement) !== transaction.originalName
  ) {
    throw new ManagedBootstrapCommitStateIndeterminateError({
      bootstrapIdentity: transaction.bootstrapIdentity,
      runtimeId: transaction.replacementRuntimeId,
      detail: "completed cutover runtime names do not match durable authority",
    });
  }
}

function removeExactReplacement(
  transaction: DockerBootstrapTransaction,
  replacement: DockerContainerInspect,
  deps: ResolvedDeps,
): void {
  assertTransactionReplacement(transaction, replacement);
  const options = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  if (replacement.State?.Running === true) {
    const stopped = deps.dockerStop(transaction.replacementRuntimeId, {
      ...options,
      timeout: DOCKER_GPU_PATCH_STOP_TIMEOUT_MS,
    });
    if (!hasZeroDockerExitStatus(stopped)) {
      const afterStop = inspectTransactionRuntime(
        transaction,
        transaction.replacementRuntimeId,
        deps,
      );
      if (!afterStop || afterStop.State?.Running === true) {
        throw new Error(
          `Managed bootstrap could not quiesce its exact replacement: ${
            commandDetail(stopped) || "Docker stop failed"
          }`,
        );
      }
      assertTransactionReplacement(transaction, afterStop);
    }
  }
  const removed = deps.dockerRm(transaction.replacementRuntimeId, options);
  if (
    !hasZeroDockerExitStatus(removed) &&
    probeExactDockerContainerAbsence(transaction.replacementRuntimeId, deps) !== "absent"
  ) {
    throw new Error(
      `Managed bootstrap could not remove its exact replacement: ${
        commandDetail(removed) || "Docker removal failed"
      }`,
    );
  }
}

function restoreOriginal(transaction: DockerBootstrapTransaction, deps: ResolvedDeps): void {
  const options = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  const originalBeforeReplacementRemoval = inspectTransactionRuntime(
    transaction,
    transaction.originalRuntimeId,
    deps,
  );
  if (!originalBeforeReplacementRemoval) {
    throw new ManagedBootstrapCommitStateIndeterminateError({
      bootstrapIdentity: transaction.bootstrapIdentity,
      runtimeId: transaction.originalRuntimeId,
      detail: "the exact rollback original is absent",
    });
  }
  assertTransactionOriginal(transaction, originalBeforeReplacementRemoval);
  const replacement = inspectTransactionRuntime(
    transaction,
    transaction.replacementRuntimeId,
    deps,
  );
  if (replacement) {
    removeExactReplacement(transaction, replacement, deps);
  }
  const original = inspectExact(transaction.originalRuntimeId, deps);
  assertTransactionOriginal(transaction, original);
  const currentName = dockerContainerName(original);
  if (currentName !== transaction.originalName) {
    if (currentName !== transaction.backupName) {
      throw new Error("Managed bootstrap original container has an unexpected rollback name.");
    }
    const renamed = deps.dockerRename(
      transaction.originalRuntimeId,
      transaction.originalName,
      options,
    );
    if (!hasZeroDockerExitStatus(renamed)) {
      const afterRename = inspectTransactionRuntime(
        transaction,
        transaction.originalRuntimeId,
        deps,
      );
      if (!afterRename || dockerContainerName(afterRename) !== transaction.originalName) {
        throw new Error(
          `Managed bootstrap could not restore the original container name: ${
            commandDetail(renamed) || "Docker rename failed"
          }`,
        );
      }
      assertTransactionOriginal(transaction, afterRename);
    }
  }
  const restoredBeforeStart = inspectExact(transaction.originalRuntimeId, deps);
  if (restoredBeforeStart.State?.Running !== true) {
    const started = deps.dockerStart(transaction.originalRuntimeId, options);
    if (!hasZeroDockerExitStatus(started)) {
      const afterStart = inspectTransactionRuntime(
        transaction,
        transaction.originalRuntimeId,
        deps,
      );
      if (!afterStart || afterStart.State?.Running !== true) {
        throw new Error(
          `Managed bootstrap could not restart the original container: ${
            commandDetail(started) || "Docker start failed"
          }`,
        );
      }
      assertTransactionOriginal(transaction, afterStart);
    }
  }
  const restored = inspectExact(transaction.originalRuntimeId, deps);
  assertStableRunning(restored, "restored workload");
  const normalized = normalizeDockerManagedBootstrapLaunchSpec(restored);
  if (normalized.hash !== transaction.originalSpecHash) {
    throw new Error("Managed bootstrap rollback did not restore the exact launch spec.");
  }
}

function retainOwnedWorkloadForOwnerCleanup(
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
  if (
    input.createReceipt.ready !== true ||
    input.createReceipt.sandbox.sandboxName !== sandbox.sandboxName ||
    input.createReceipt.sandbox.sandboxId !== sandbox.sandboxId ||
    input.createReceipt.sandbox.driverId !== sandbox.driverId
  ) {
    throw new Error(
      "Managed bootstrap Docker incomplete-create workload does not match the exact validated create receipt.",
    );
  }
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

function sameDockerBootstrapJournal(
  left: DockerBootstrapTransaction,
  right: DockerBootstrapTransaction,
): boolean {
  return (
    serializeDockerManagedBootstrapJournal(left) === serializeDockerManagedBootstrapJournal(right)
  );
}

function sameDockerBootstrapPreparedAuthority(
  left: DockerBootstrapTransaction,
  right: DockerBootstrapTransaction,
): boolean {
  return sameDockerBootstrapJournal(
    Object.freeze({
      ...left,
      phase: "staged" as const,
      preparationReceipt: null,
      commitReceipt: null,
    }),
    Object.freeze({
      ...right,
      phase: "staged" as const,
      preparationReceipt: null,
      commitReceipt: null,
    }),
  );
}

function createDockerBootstrapJournalDurably(
  journal: DockerBootstrapTransaction,
  deps: ResolvedDeps,
): DockerBootstrapTransaction {
  try {
    deps.journalStore.create(journal);
  } catch (error) {
    if (!(error instanceof DockerManagedBootstrapJournalAcknowledgementLostError)) throw error;
    const recovered = deps.journalStore.load(journal.bootstrapIdentity);
    if (!recovered || !sameDockerBootstrapJournal(recovered, journal)) throw error;
    return recovered;
  }
  const persisted = deps.journalStore.load(journal.bootstrapIdentity);
  if (!persisted || !sameDockerBootstrapJournal(persisted, journal)) {
    throw new Error("Managed bootstrap Docker staged journal was not durably re-readable.");
  }
  return persisted;
}

function transitionDockerBootstrapJournalDurably(
  journal: DockerBootstrapTransaction,
  next: "cutover" | "rollback-authorized" | "shared-state-committed",
  deps: ResolvedDeps,
): DockerBootstrapTransaction {
  try {
    deps.journalStore.transition(journal.bootstrapIdentity, journal.phase, next);
  } catch (error) {
    if (!(error instanceof DockerManagedBootstrapJournalAcknowledgementLostError)) throw error;
    const recovered = deps.journalStore.load(journal.bootstrapIdentity);
    const expected = Object.freeze({ ...journal, phase: next });
    if (!recovered || !sameDockerBootstrapJournal(recovered, expected)) throw error;
    return recovered;
  }
  const persisted = deps.journalStore.load(journal.bootstrapIdentity);
  const expected = Object.freeze({ ...journal, phase: next });
  if (!persisted || !sameDockerBootstrapJournal(persisted, expected)) {
    throw new Error(`Managed bootstrap Docker journal transition to ${next} was not durable.`);
  }
  return persisted;
}

function recordDockerBootstrapCompletionDurably(
  journal: DockerBootstrapTransaction,
  receipt: ManagedBootstrapCompletionReceipt,
  deps: ResolvedDeps,
): DockerBootstrapTransaction {
  const expected = Object.freeze({ ...journal, commitReceipt: receipt });
  try {
    deps.journalStore.recordCompletion(journal.bootstrapIdentity, receipt);
  } catch (error) {
    if (!(error instanceof DockerManagedBootstrapJournalAcknowledgementLostError)) throw error;
    const recovered = deps.journalStore.load(journal.bootstrapIdentity);
    if (!recovered || !sameDockerBootstrapJournal(recovered, expected)) throw error;
    return recovered;
  }
  const persisted = deps.journalStore.load(journal.bootstrapIdentity);
  if (!persisted || !sameDockerBootstrapJournal(persisted, expected)) {
    throw new Error("Managed bootstrap Docker completion receipt was not durably re-readable.");
  }
  return persisted;
}

function removeDockerBootstrapJournalDurably(
  journal: DockerBootstrapTransaction,
  deps: ResolvedDeps,
): void {
  try {
    deps.journalStore.remove(journal.bootstrapIdentity, [journal.phase]);
  } catch (error) {
    if (!(error instanceof DockerManagedBootstrapJournalAcknowledgementLostError)) throw error;
    const recovered = deps.journalStore.load(journal.bootstrapIdentity);
    if (recovered !== null) throw error;
    return;
  }
  if (deps.journalStore.load(journal.bootstrapIdentity) !== null) {
    throw new Error("Managed bootstrap Docker journal removal was not durable.");
  }
}

function assertDockerBootstrapTransactionAuthority(
  transaction: DockerBootstrapTransaction,
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
  prepared?: ManagedBootstrapPreparedReplacementHandle | null,
  replacement?: ManagedBootstrapReplacementHandle | null,
  durablePreparation?: ManagedBootstrapDurablePreparationReceipt | null,
): void {
  const originalName = dockerContainerName(
    parseDockerManagedBootstrapLaunchSpec(snapshot.specCanonicalJson).inspect,
  );
  const expectedSandbox = handle.sandbox;
  if (
    transaction.schemaVersion !== DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION ||
    transaction.bootstrapIdentity !== handle.bootstrapIdentity ||
    transaction.providerId !== expectedSandbox.driverId ||
    transaction.sandbox.sandboxName !== expectedSandbox.sandboxName ||
    transaction.sandbox.sandboxId !== expectedSandbox.sandboxId ||
    transaction.sandbox.driverId !== expectedSandbox.driverId ||
    transaction.planFingerprint !== createManagedBootstrapPlanFingerprint(handle.plan) ||
    transaction.profileFingerprint !== handle.plan.profile.fingerprint ||
    transaction.imageReference !==
      expectedImageReference(snapshot.image.repository, snapshot.image.manifestDigest) ||
    transaction.runtimeImageContentId !== snapshot.runtimeImageContentId ||
    transaction.originalRuntimeId !== snapshot.runtimeId ||
    transaction.originalName !== originalName ||
    transaction.replacementStagingName !==
      replacementStagingName(originalName, handle.bootstrapIdentity) ||
    transaction.backupName !== backupName(originalName, handle.bootstrapIdentity) ||
    transaction.originalSpecHash !== snapshot.specHash ||
    transaction.rollbackTargetRuntimeId !== snapshot.runtimeId ||
    transaction.rollbackTargetSpecHash !== snapshot.specHash ||
    (transaction.preparationReceipt !== null &&
      prepared !== undefined &&
      prepared !== null &&
      transaction.preparationReceipt.authorityFingerprint !==
        createManagedBootstrapPreparedAuthority({ handle, snapshot, prepared })
          .authorityFingerprint) ||
    (durablePreparation !== undefined &&
      durablePreparation !== null &&
      (transaction.preparationReceipt === null ||
        !sameDockerManagedBootstrapReceipt(
          "preparation",
          transaction.preparationReceipt,
          durablePreparation,
        ))) ||
    (prepared !== undefined &&
      prepared !== null &&
      (transaction.originalRuntimeId !== prepared.originalRuntimeId ||
        transaction.replacementRuntimeId !== prepared.preparedRuntimeId ||
        transaction.replacementSpecHash !== prepared.expectedActivatedSpecHash)) ||
    (replacement !== undefined &&
      replacement !== null &&
      (transaction.originalRuntimeId !== replacement.originalRuntimeId ||
        transaction.replacementRuntimeId !== replacement.replacementRuntimeId ||
        transaction.replacementSpecHash !== replacement.replacementSpecHash))
  ) {
    throw new Error(
      "Managed bootstrap receipts do not match the durable Docker transaction authority.",
    );
  }
}

function transactionFromPreparedAuthority(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
  prepared: ManagedBootstrapPreparedReplacementHandle,
): DockerBootstrapTransaction {
  const transaction = parseDockerManagedBootstrapJournal(prepared.rollbackAuthority);
  if (transaction.phase !== "staged") {
    throw new Error("Managed bootstrap Docker prepared authority must describe a staged runtime.");
  }
  assertDockerBootstrapTransactionAuthority(transaction, handle, snapshot, prepared);
  return transaction;
}

function assertDurablePreparationAuthority(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
  prepared: ManagedBootstrapPreparedReplacementHandle,
  receipt: ManagedBootstrapDurablePreparationReceipt,
): void {
  const authority = createManagedBootstrapPreparedAuthority({ handle, snapshot, prepared });
  const recordedAt = new Date(receipt.recordedAt);
  if (
    receipt.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
    receipt.sandbox.sandboxName !== authority.sandbox.sandboxName ||
    receipt.sandbox.sandboxId !== authority.sandbox.sandboxId ||
    receipt.sandbox.driverId !== authority.sandbox.driverId ||
    receipt.bootstrapIdentity !== authority.bootstrapIdentity ||
    receipt.authorityFingerprint !== authority.authorityFingerprint ||
    typeof receipt.recordId !== "string" ||
    receipt.recordId.length === 0 ||
    receipt.recordId.includes("\0") ||
    typeof receipt.recordedAt !== "string" ||
    !Number.isFinite(recordedAt.getTime()) ||
    recordedAt.toISOString() !== receipt.recordedAt
  ) {
    throw new Error(
      "Managed bootstrap Docker activation requires the exact durable prepared-authority receipt.",
    );
  }
}

function reconstructDockerBootstrapTransaction(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
  replacement: ManagedBootstrapReplacementHandle,
  deps: ResolvedDeps,
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
  const transaction = deps.journalStore.load(handle.bootstrapIdentity);
  if (!transaction) {
    throw new ManagedBootstrapCommitStateIndeterminateError({
      bootstrapIdentity: handle.bootstrapIdentity,
      runtimeId: replacement.replacementRuntimeId,
      detail: "the durable Docker cutover journal is absent",
    });
  }
  assertDockerBootstrapTransactionAuthority(transaction, handle, snapshot, null, replacement);
  return transaction;
}

function cleanupUnjournaledPreparedContainer(
  input: {
    readonly snapshot: ManagedBootstrapObservedSnapshot;
    readonly preparedRuntimeId: string;
    readonly stagingName: string;
  },
  deps: ResolvedDeps,
): void {
  if (!FULL_CONTAINER_ID_RE.test(input.preparedRuntimeId)) return;
  const original = inspectExact(input.snapshot.runtimeId, deps);
  const originalName = dockerContainerName(
    parseDockerManagedBootstrapLaunchSpec(input.snapshot.specCanonicalJson).inspect,
  );
  if (
    !isStableRunning(original) ||
    dockerContainerName(original) !== originalName ||
    normalizeDockerManagedBootstrapLaunchSpec(original).hash !== input.snapshot.specHash
  ) {
    throw new Error(
      "Managed bootstrap cannot clean an unjournaled replacement after original drift.",
    );
  }
  const prepared = tryInspectExact(input.preparedRuntimeId, deps);
  if (!prepared) return;
  if (
    String(prepared.Id ?? "").toLowerCase() !== input.preparedRuntimeId ||
    dockerContainerName(prepared) !== input.stagingName ||
    !isExplicitlyStopped(prepared)
  ) {
    throw new Error(
      "Managed bootstrap refused cleanup because the unjournaled prepared runtime changed.",
    );
  }
  const removed = deps.dockerRm(input.preparedRuntimeId, {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  });
  if (
    !hasZeroDockerExitStatus(removed) &&
    probeExactDockerContainerAbsence(input.preparedRuntimeId, deps) !== "absent"
  ) {
    throw new Error(
      `Managed bootstrap could not remove its unjournaled prepared runtime: ${
        commandDetail(removed) || "Docker removal failed"
      }`,
    );
  }
}

function resolvePreparedRollbackAuthority(input: {
  readonly handle: ManagedBootstrapHeldWorkloadHandle;
  readonly snapshot: ManagedBootstrapObservedSnapshot;
  readonly prepared: ManagedBootstrapPreparedReplacementHandle | null;
  readonly durablePreparation: ManagedBootstrapDurablePreparationReceipt | null;
}): DockerBootstrapTransaction | null {
  if (input.durablePreparation && !input.prepared) {
    throw new ManagedBootstrapCommitStateIndeterminateError({
      bootstrapIdentity: input.handle.bootstrapIdentity,
      runtimeId: input.snapshot.runtimeId,
      detail: "durable prepared authority is present without its exact prepared handle",
    });
  }
  if (!input.prepared) return null;
  const authority = transactionFromPreparedAuthority(input.handle, input.snapshot, input.prepared);
  if (input.durablePreparation) {
    assertDurablePreparationAuthority(
      input.handle,
      input.snapshot,
      input.prepared,
      input.durablePreparation,
    );
  }
  return authority;
}

export function createDockerManagedBootstrapAdapter(
  dependencies: DockerManagedBootstrapDeps = {},
): DockerManagedBootstrapAdapter {
  const deps = resolveDeps(dependencies);
  const finalizationRecord = (
    handle: ManagedBootstrapHeldWorkloadHandle,
  ): DockerManagedBootstrapFinalizationRecord | null => {
    const record = deps.journalStore.loadFinalization(handle.bootstrapIdentity);
    if (!record) return null;
    if (
      record.providerId !== handle.sandbox.driverId ||
      record.sandbox.sandboxName !== handle.sandbox.sandboxName ||
      record.sandbox.sandboxId !== handle.sandbox.sandboxId ||
      record.sandbox.driverId !== handle.sandbox.driverId ||
      record.planFingerprint !== createManagedBootstrapPlanFingerprint(handle.plan) ||
      record.profileFingerprint !== handle.plan.profile.fingerprint ||
      record.imageReference !==
        expectedImageReference(handle.plan.image.repository, handle.plan.image.manifestDigest)
    ) {
      throw new Error("Managed bootstrap finalization record does not match its durable identity.");
    }
    return record;
  };
  const persistFinalization = (
    handle: ManagedBootstrapHeldWorkloadHandle,
    phase: "committed" | "rolled-back",
    commitReceipt: ManagedBootstrapCompletionReceipt | null,
    cleanupReceipt: ManagedBootstrapFinalizationReceipt,
  ): ManagedBootstrapFinalizationReceipt => {
    const record = Object.freeze({
      schemaVersion: DOCKER_MANAGED_BOOTSTRAP_FINALIZATION_SCHEMA_VERSION,
      phase,
      bootstrapIdentity: handle.bootstrapIdentity,
      providerId: handle.sandbox.driverId,
      sandbox: handle.sandbox,
      planFingerprint: createManagedBootstrapPlanFingerprint(handle.plan),
      profileFingerprint: handle.plan.profile.fingerprint,
      imageReference: expectedImageReference(
        handle.plan.image.repository,
        handle.plan.image.manifestDigest,
      ),
      commitReceipt,
      cleanupReceipt,
    } satisfies DockerManagedBootstrapFinalizationRecord);
    const serialized = serializeDockerManagedBootstrapFinalizationRecord(record);
    try {
      deps.journalStore.recordFinalization(record);
    } catch (error) {
      const recovered = deps.journalStore.loadFinalization(handle.bootstrapIdentity);
      if (
        !recovered ||
        serializeDockerManagedBootstrapFinalizationRecord(recovered) !== serialized
      ) {
        throw error;
      }
    }
    const persisted = deps.journalStore.loadFinalization(handle.bootstrapIdentity);
    if (!persisted || serializeDockerManagedBootstrapFinalizationRecord(persisted) !== serialized) {
      throw new Error("Managed bootstrap finalization receipt was not durably re-readable.");
    }
    return persisted.cleanupReceipt;
  };
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
    return persistFinalization(handle, "rolled-back", null, receipt);
  };
  const completedCommit = (
    handle: ManagedBootstrapHeldWorkloadHandle,
    commitReceipt: ManagedBootstrapCompletionReceipt,
  ): ManagedBootstrapFinalizationReceipt => {
    const cleanupReceipt = Object.freeze({
      schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      outcome: "committed",
      restoredRuntimeId: null,
      restoredSpecHash: null,
      heldWorkloadRemoved: false,
      alreadyRolledBack: false,
      finalizedAt: deps.now().toISOString(),
    } satisfies ManagedBootstrapFinalizationReceipt);
    return persistFinalization(handle, "committed", commitReceipt, cleanupReceipt);
  };
  const priorRollback = (
    handle: ManagedBootstrapHeldWorkloadHandle,
  ): ManagedBootstrapFinalizationReceipt | null => {
    const finalized = finalizationRecord(handle);
    if (!finalized) return null;
    if (finalized.phase === "committed") {
      throw new ManagedBootstrapDurableCommitCleanupPendingError({
        bootstrapIdentity: handle.bootstrapIdentity,
        cleanupRuntimeId: finalized.commitReceipt?.runtimeId ?? "unknown",
        detail: "rollback is no longer legal after the durable finalization receipt",
      });
    }
    return Object.freeze({
      ...finalized.cleanupReceipt,
      alreadyRolledBack: true,
    });
  };
  const rollbackBootstrapNow = ({
    handle,
    snapshot,
    prepared,
    durablePreparation,
    replacement,
    sharedStateAlreadyRolledBack = false,
  }: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot | null;
    readonly prepared: ManagedBootstrapPreparedReplacementHandle | null;
    readonly durablePreparation: ManagedBootstrapDurablePreparationReceipt | null;
    readonly replacement: ManagedBootstrapReplacementHandle | null;
    readonly sharedStateAlreadyRolledBack?: boolean;
  }): ManagedBootstrapFinalizationReceipt => {
    const finalized = priorRollback(handle);
    if (finalized) return finalized;
    const journal = deps.journalStore.load(handle.bootstrapIdentity);
    if (journal?.phase === "shared-state-committed") {
      throw new ManagedBootstrapDurableCommitCleanupPendingError({
        bootstrapIdentity: handle.bootstrapIdentity,
        cleanupRuntimeId: journal?.originalRuntimeId ?? snapshot?.runtimeId ?? "unknown",
        detail:
          "rollback is no longer legal after the durable Docker commit fence; retry commit finalization",
      });
    }
    if (!snapshot) {
      if (journal || prepared || durablePreparation || replacement) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: handle.bootstrapIdentity,
          runtimeId: journal?.originalRuntimeId ?? prepared?.originalRuntimeId ?? "unknown",
          detail: "Docker replacement authority exists without its observed snapshot",
        });
      }
      retainOwnedWorkloadForOwnerCleanup(handle.sandbox, deps);
      return completedRollback(handle, false);
    }

    const preparedAuthority = resolvePreparedRollbackAuthority({
      handle,
      snapshot,
      prepared,
      durablePreparation,
    });

    if (!journal) {
      const originalPresence = probeExactDockerContainerAbsence(snapshot.runtimeId, deps);
      if (originalPresence === "unknown") {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: handle.bootstrapIdentity,
          runtimeId: snapshot.runtimeId,
          detail: "the original runtime presence is unknown and no durable journal is available",
        });
      }
      if (originalPresence === "absent") {
        throw new ManagedBootstrapDurableCommitCleanupPendingError({
          bootstrapIdentity: handle.bootstrapIdentity,
          cleanupRuntimeId: snapshot.runtimeId,
          detail:
            "rollback is forbidden because the exact original is absent after journal retirement",
        });
      }
      const original = inspectExact(snapshot.runtimeId, deps);
      const expectedOriginalName = dockerContainerName(
        parseDockerManagedBootstrapLaunchSpec(snapshot.specCanonicalJson).inspect,
      );
      const normalized = normalizeDockerManagedBootstrapLaunchSpec(original);
      if (
        dockerContainerName(original) !== expectedOriginalName ||
        original.State?.Running !== true ||
        normalized.hash !== snapshot.specHash
      ) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: handle.bootstrapIdentity,
          runtimeId: snapshot.runtimeId,
          detail: "the journal is absent and the exact original is not a proven restored workload",
        });
      }
      if (preparedAuthority) {
        const observedPrepared = inspectTransactionRuntime(
          preparedAuthority,
          preparedAuthority.replacementRuntimeId,
          deps,
        );
        if (observedPrepared) {
          assertExplicitlyStopped(observedPrepared, "prepared replacement");
          if (
            dockerContainerName(observedPrepared) !== preparedAuthority.replacementStagingName ||
            normalizeDockerManagedBootstrapLaunchSpec(observedPrepared).canonicalJson !==
              prepared?.preparedSpecCanonicalJson
          ) {
            throw new ManagedBootstrapCommitStateIndeterminateError({
              bootstrapIdentity: handle.bootstrapIdentity,
              runtimeId: preparedAuthority.replacementRuntimeId,
              detail: "the unjournaled prepared runtime changed before exact cleanup",
            });
          }
          removeExactReplacement(preparedAuthority, observedPrepared, deps);
        }
      } else if (replacement) {
        const replacementPresence = probeExactDockerContainerAbsence(
          replacement.replacementRuntimeId,
          deps,
        );
        if (replacementPresence !== "absent") {
          throw new ManagedBootstrapCommitStateIndeterminateError({
            bootstrapIdentity: handle.bootstrapIdentity,
            runtimeId: replacement.replacementRuntimeId,
            detail:
              replacementPresence === "present"
                ? "the replacement still exists without durable journal authority"
                : "replacement absence is unknown without durable journal authority",
          });
        }
      }
      retainOwnedWorkloadForOwnerCleanup(handle.sandbox, deps, snapshot.runtimeId);
      return completedRollback(handle, true);
    }

    if (!preparedAuthority || !durablePreparation) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: handle.bootstrapIdentity,
        runtimeId: journal.replacementRuntimeId,
        detail: "durable Docker cutover lacks its coordinator-recorded prepared authority",
      });
    }
    if (!sameDockerBootstrapPreparedAuthority(journal, preparedAuthority)) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: handle.bootstrapIdentity,
        runtimeId: journal.replacementRuntimeId,
        detail: "durable Docker cutover changed its prepared rollback authority",
      });
    }
    assertDockerBootstrapTransactionAuthority(
      journal,
      handle,
      snapshot,
      prepared,
      replacement,
      durablePreparation,
    );
    const original = inspectTransactionRuntime(journal, journal.originalRuntimeId, deps);
    if (!original) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: journal.bootstrapIdentity,
        runtimeId: journal.originalRuntimeId,
        detail: "the exact rollback original is absent",
      });
    }
    assertTransactionOriginal(journal, original);
    const observedReplacement = inspectTransactionRuntime(
      journal,
      journal.replacementRuntimeId,
      deps,
    );

    if (journal.phase === "staged") {
      assertStableRunning(original, "staged original");
      if (observedReplacement) {
        assertExplicitlyStopped(observedReplacement, "staged replacement");
      }
      if (
        dockerContainerName(original) !== journal.originalName ||
        (observedReplacement !== null &&
          dockerContainerName(observedReplacement) !== journal.replacementStagingName)
      ) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: journal.bootstrapIdentity,
          runtimeId: journal.originalRuntimeId,
          detail: "staged transaction runtime state does not match its pre-cutover fence",
        });
      }
      if (observedReplacement) {
        removeExactReplacement(journal, observedReplacement, deps);
      }
      removeDockerBootstrapJournalDurably(journal, deps);
      retainOwnedWorkloadForOwnerCleanup(handle.sandbox, deps, journal.originalRuntimeId);
      return completedRollback(handle, false);
    }

    if (journal.phase !== "cutover" && journal.phase !== "rollback-authorized") {
      throw new ManagedBootstrapDurableCommitCleanupPendingError({
        bootstrapIdentity: journal.bootstrapIdentity,
        cleanupRuntimeId: journal.originalRuntimeId,
        detail: "rollback is forbidden by the durable Docker commit phase",
      });
    }

    const originalNameNow = dockerContainerName(original);
    const replacementNameNow = observedReplacement
      ? dockerContainerName(observedReplacement)
      : null;
    const originalAtTargetRecoverable =
      originalNameNow === journal.originalName &&
      (isStableRunning(original) || isExplicitlyStopped(original));
    const originalAtBackupRecoverable =
      originalNameNow === journal.backupName && isExplicitlyStopped(original);
    const replacementAtStagingRecoverable =
      replacementNameNow === journal.replacementStagingName &&
      observedReplacement !== null &&
      isExplicitlyStopped(observedReplacement);
    const replacementAtTargetRecoverable =
      replacementNameNow === journal.originalName &&
      observedReplacement !== null &&
      (isStableRunning(observedReplacement) || isExplicitlyStopped(observedReplacement));
    const validCutoverState =
      (originalAtTargetRecoverable && replacementAtStagingRecoverable) ||
      (originalAtBackupRecoverable && replacementAtStagingRecoverable) ||
      (originalAtBackupRecoverable && replacementAtTargetRecoverable);
    let activeJournal = journal;

    if (journal.phase === "cutover") {
      if (
        (!sharedStateAlreadyRolledBack && (!observedReplacement || !validCutoverState)) ||
        (sharedStateAlreadyRolledBack &&
          (observedReplacement !== null ||
            !(
              (originalNameNow === journal.backupName && isExplicitlyStopped(original)) ||
              originalAtTargetRecoverable
            )))
      ) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: journal.bootstrapIdentity,
          runtimeId: journal.replacementRuntimeId,
          detail:
            observedReplacement === null && !sharedStateAlreadyRolledBack
              ? "the exact replacement disappeared before rollback authorization was durable"
              : "cutover runtime names or states do not match a recoverable phase",
        });
      }
      const current = deps.journalStore.load(journal.bootstrapIdentity);
      if (!current || !sameDockerBootstrapJournal(current, journal)) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: journal.bootstrapIdentity,
          runtimeId: journal.replacementRuntimeId,
          detail: "durable transaction authority changed before rollback authorization",
        });
      }

      let sharedStatus: "committed" | "none" | "pending" = "none";
      const sharedTransaction = managedSharedStateTransaction(
        handle,
        journal.replacementRuntimeId,
        journal.runtimeImageContentId,
      );
      if (!sharedStateAlreadyRolledBack) {
        sharedStatus = probeDockerManagedStartupSharedState(
          {
            transaction: sharedTransaction,
            profileFingerprint: journal.profileFingerprint,
          },
          deps,
        );
        if (sharedStatus === "committed") {
          const committedJournal = transitionDockerBootstrapJournalDurably(
            journal,
            "shared-state-committed",
            deps,
          );
          throw new ManagedBootstrapDurableCommitCleanupPendingError({
            bootstrapIdentity: committedJournal.bootstrapIdentity,
            cleanupRuntimeId: committedJournal.originalRuntimeId,
            detail: "image-owned shared state is durably committed; rollback is no longer legal",
          });
        }
      }
      activeJournal = transitionDockerBootstrapJournalDurably(journal, "rollback-authorized", deps);
      if (!sharedStateAlreadyRolledBack && sharedStatus === "pending") {
        finalizeDockerManagedStartupSharedState(
          {
            transaction: sharedTransaction,
            supervisorReady: false,
            retainContainerAfterRollback: true,
          },
          deps,
        );
      }
    } else {
      if (!originalAtTargetRecoverable && !originalAtBackupRecoverable) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: journal.bootstrapIdentity,
          runtimeId: journal.originalRuntimeId,
          detail: "rollback-authorized original runtime state is not recoverable",
        });
      }
      if (
        observedReplacement &&
        originalNameNow === journal.originalName &&
        replacementNameNow === journal.originalName
      ) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: journal.bootstrapIdentity,
          runtimeId: journal.replacementRuntimeId,
          detail: "both transaction runtimes claim the authoritative workload name",
        });
      }
      if (observedReplacement) {
        const current = deps.journalStore.load(journal.bootstrapIdentity);
        if (!current || !sameDockerBootstrapJournal(current, journal)) {
          throw new ManagedBootstrapCommitStateIndeterminateError({
            bootstrapIdentity: journal.bootstrapIdentity,
            runtimeId: journal.replacementRuntimeId,
            detail: "rollback authorization changed before replacement cleanup",
          });
        }
        const sharedTransaction = managedSharedStateTransaction(
          handle,
          journal.replacementRuntimeId,
          journal.runtimeImageContentId,
        );
        const sharedStatus = probeDockerManagedStartupSharedState(
          {
            transaction: sharedTransaction,
            profileFingerprint: journal.profileFingerprint,
          },
          deps,
        );
        if (sharedStatus === "committed") {
          throw new ManagedBootstrapCommitStateIndeterminateError({
            bootstrapIdentity: journal.bootstrapIdentity,
            runtimeId: journal.replacementRuntimeId,
            detail:
              "shared state became committed after rollback authorization; no mutation was attempted",
          });
        }
        if (sharedStatus === "pending") {
          finalizeDockerManagedStartupSharedState(
            {
              transaction: sharedTransaction,
              supervisorReady: false,
              retainContainerAfterRollback: true,
            },
            deps,
          );
        }
      }
    }

    const beforeRestore = deps.journalStore.load(activeJournal.bootstrapIdentity);
    if (!beforeRestore || !sameDockerBootstrapJournal(beforeRestore, activeJournal)) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: journal.bootstrapIdentity,
        runtimeId: journal.originalRuntimeId,
        detail: "durable transaction authority changed before original restoration",
      });
    }
    restoreOriginal(activeJournal, deps);
    const restored = inspectExact(activeJournal.originalRuntimeId, deps);
    assertStableRunning(restored, "restored workload");
    if (
      dockerContainerName(restored) !== activeJournal.originalName ||
      normalizeDockerManagedBootstrapLaunchSpec(restored).hash !== activeJournal.originalSpecHash
    ) {
      throw new Error("Managed bootstrap Docker rollback did not restore its exact original.");
    }
    removeDockerBootstrapJournalDurably(activeJournal, deps);
    retainOwnedWorkloadForOwnerCleanup(handle.sandbox, deps, activeJournal.originalRuntimeId);
    return completedRollback(handle, false);
  };
  const commitBootstrapNow = (
    handle: ManagedBootstrapHeldWorkloadHandle,
    receipt: ManagedBootstrapCompletionReceipt,
    transaction: DockerBootstrapTransaction,
    input: {
      readonly sharedStateStatus: "committed" | "none";
      readonly sharedStateTransaction: ReturnType<typeof managedSharedStateTransaction>;
    },
  ): ManagedBootstrapFinalizationReceipt => {
    if (
      transaction.phase !== "shared-state-committed" ||
      transaction.replacementRuntimeId !== receipt.runtimeId ||
      transaction.originalSpecHash !== receipt.originalSpecHash ||
      transaction.replacementSpecHash !== receipt.replacementSpecHash
    ) {
      throw new Error("Managed bootstrap Docker commit receipt does not match its commit fence.");
    }
    const current = deps.journalStore.load(transaction.bootstrapIdentity);
    if (!current || !sameDockerBootstrapJournal(current, transaction)) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: transaction.bootstrapIdentity,
        runtimeId: transaction.originalRuntimeId,
        detail: "durable commit authority changed before exact cleanup",
      });
    }

    const replacement = inspectTransactionRuntime(
      transaction,
      transaction.replacementRuntimeId,
      deps,
    );
    if (!replacement) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: transaction.bootstrapIdentity,
        runtimeId: transaction.replacementRuntimeId,
        detail: "the exact committed replacement is absent",
      });
    }
    assertTransactionReplacement(transaction, replacement);
    if (
      dockerContainerName(replacement) !== transaction.originalName ||
      replacement.State?.Running !== true
    ) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: transaction.bootstrapIdentity,
        runtimeId: transaction.replacementRuntimeId,
        detail: "the exact replacement is not running under the authoritative workload name",
      });
    }

    const original = inspectTransactionRuntime(transaction, transaction.originalRuntimeId, deps);
    if (original) {
      assertTransactionOriginal(transaction, original);
      if (dockerContainerName(original) !== transaction.backupName) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: transaction.bootstrapIdentity,
          runtimeId: transaction.originalRuntimeId,
          detail: "the exact rollback backup is not quiescent under its durable backup name",
        });
      }
      assertExplicitlyStopped(original, "commit rollback backup");
      const beforeRemove = deps.journalStore.load(transaction.bootstrapIdentity);
      if (!beforeRemove || !sameDockerBootstrapJournal(beforeRemove, transaction)) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: transaction.bootstrapIdentity,
          runtimeId: transaction.originalRuntimeId,
          detail: "durable commit authority changed before exact rollback-backup removal",
        });
      }
      const removed = deps.dockerRm(transaction.originalRuntimeId, {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      if (
        !hasZeroDockerExitStatus(removed) &&
        probeExactDockerContainerAbsence(transaction.originalRuntimeId, deps) !== "absent"
      ) {
        throw new ManagedBootstrapDurableCommitCleanupPendingError({
          bootstrapIdentity: receipt.bootstrapIdentity,
          cleanupRuntimeId: transaction.originalRuntimeId,
          detail: `${commandDetail(removed) || "Docker removal failed"}; exact backup absence was not proven`,
        });
      }
    }

    if (input.sharedStateStatus === "committed") {
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
    removeDockerBootstrapJournalDurably(transaction, deps);
    return completedCommit(handle, receipt);
  };
  const finalizeBootstrap = async (
    input: Parameters<ManagedBootstrapAdapter["finalizeBootstrap"]>[0],
  ): Promise<ManagedBootstrapFinalizationReceipt> => {
    if (input.outcome === "rollback") {
      return rollbackBootstrapNow(input);
    }
    const { completion, durablePreparation, handle, prepared, replacement, snapshot } = input;
    if (!completion || !snapshot || !prepared || !durablePreparation || !replacement) {
      throw new Error("Managed bootstrap commit requires one complete cutover receipt.");
    }
    const finalized = finalizationRecord(handle);
    if (finalized) {
      if (
        finalized.phase !== "committed" ||
        !finalized.commitReceipt ||
        !sameDockerManagedBootstrapReceipt("completion", finalized.commitReceipt, completion)
      ) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: handle.bootstrapIdentity,
          runtimeId: replacement.replacementRuntimeId,
          detail: "durable finalization cannot change outcome or commit receipt",
        });
      }
      return finalized.cleanupReceipt;
    }
    const preparedAuthority = transactionFromPreparedAuthority(handle, snapshot, prepared);
    assertDurablePreparationAuthority(handle, snapshot, prepared, durablePreparation);
    const sharedTransaction = managedSharedStateTransaction(
      handle,
      replacement.replacementRuntimeId,
      replacement.runtimeImageContentId,
    );
    let sharedStatus = probeDockerManagedStartupSharedState(
      {
        transaction: sharedTransaction,
        profileFingerprint: completion.profileFingerprint,
      },
      deps,
    );
    let journal = deps.journalStore.load(handle.bootstrapIdentity);

    if (!journal) {
      const originalPresence = probeExactDockerContainerAbsence(snapshot.runtimeId, deps);
      if (originalPresence === "unknown") {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: completion.bootstrapIdentity,
          runtimeId: snapshot.runtimeId,
          detail: "the retired-journal commit cannot prove exact backup absence",
        });
      }
      if (originalPresence !== "absent" || sharedStatus !== "none") {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: completion.bootstrapIdentity,
          runtimeId:
            originalPresence === "absent" ? replacement.replacementRuntimeId : snapshot.runtimeId,
          detail:
            "the durable journal is absent before both exact backup and shared commit receipt retirement were proven",
        });
      }
      const committedReplacement = inspectExact(replacement.replacementRuntimeId, deps);
      assertStableRunning(committedReplacement, "committed replacement");
      const originalName = dockerContainerName(
        parseDockerManagedBootstrapLaunchSpec(snapshot.specCanonicalJson).inspect,
      );
      if (
        dockerContainerName(committedReplacement) !== originalName ||
        normalizeDockerManagedBootstrapLaunchSpec(committedReplacement).hash !==
          replacement.replacementSpecHash
      ) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: completion.bootstrapIdentity,
          runtimeId: replacement.replacementRuntimeId,
          detail: "the retired-journal replacement does not match the exact completion receipt",
        });
      }
      return completedCommit(handle, completion);
    }

    if (!sameDockerBootstrapPreparedAuthority(journal, preparedAuthority)) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: handle.bootstrapIdentity,
        runtimeId: journal.replacementRuntimeId,
        detail: "durable Docker commit changed its prepared rollback authority",
      });
    }
    assertDockerBootstrapTransactionAuthority(
      journal,
      handle,
      snapshot,
      prepared,
      replacement,
      durablePreparation,
    );
    if (
      journal.commitReceipt === null ||
      !sameDockerManagedBootstrapReceipt("completion", journal.commitReceipt, completion)
    ) {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: journal.bootstrapIdentity,
        runtimeId: journal.replacementRuntimeId,
        detail: "commit requires the exact durable completion receipt",
      });
    }
    if (journal.phase === "staged" || journal.phase === "rollback-authorized") {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: journal.bootstrapIdentity,
        runtimeId: journal.replacementRuntimeId,
        detail: `commit is forbidden from durable journal phase ${journal.phase}`,
      });
    }
    if (!completion.transactionPending && sharedStatus !== "none") {
      throw new Error(
        "Managed bootstrap image completion disagrees with shared-state transaction status.",
      );
    }

    if (journal.phase === "cutover") {
      if (completion.transactionPending && sharedStatus === "none") {
        throw new Error(
          "Managed bootstrap image completion lost its shared-state receipt before the durable commit fence.",
        );
      }
      if (sharedStatus === "pending") {
        let outcome;
        try {
          outcome = finalizeDockerManagedStartupSharedState(
            {
              transaction: sharedTransaction,
              supervisorReady: true,
              retainContainerAfterRollback: true,
            },
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
          try {
            const current = deps.journalStore.load(journal.bootstrapIdentity);
            if (!current || !sameDockerBootstrapJournal(current, journal)) {
              throw new ManagedBootstrapCommitStateIndeterminateError({
                bootstrapIdentity: journal.bootstrapIdentity,
                runtimeId: journal.originalRuntimeId,
                detail:
                  "durable authority changed after shared-state rollback and before restoration",
              });
            }
            transitionDockerBootstrapJournalDurably(journal, "rollback-authorized", deps);
            await rollbackBootstrapNow({
              handle,
              snapshot,
              prepared,
              durablePreparation,
              replacement,
              sharedStateAlreadyRolledBack: true,
            });
          } catch (rollbackError) {
            attachManagedBootstrapRollbackError(failure, rollbackError);
          }
          throw failure;
        }
        sharedStatus = "committed";
      }
      journal = transitionDockerBootstrapJournalDurably(journal, "shared-state-committed", deps);
    } else if (completion.transactionPending && sharedStatus === "pending") {
      throw new ManagedBootstrapCommitStateIndeterminateError({
        bootstrapIdentity: journal.bootstrapIdentity,
        runtimeId: journal.replacementRuntimeId,
        detail: "shared state is pending after the durable Docker commit fence",
      });
    }

    return commitBootstrapNow(handle, completion, journal, {
      sharedStateStatus: sharedStatus === "committed" ? "committed" : "none",
      sharedStateTransaction: sharedTransaction,
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
      retainOwnedWorkloadForOwnerCleanup(sandbox, deps, runtimeId);
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

    async prepareBootstrapReplacement({ handle, snapshot, request, replacementOptions }) {
      if (
        snapshot.bootstrapIdentity !== handle.bootstrapIdentity ||
        !FULL_CONTAINER_ID_RE.test(snapshot.runtimeId) ||
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
      assertNoRootProcessInjectionEnvironment(parsed.inspect.Config?.Env);
      if (parsed.inspect.HostConfig?.ReadonlyRootfs === true) {
        throw new Error(
          "Managed bootstrap cannot stage its root-owned request in a read-only root filesystem.",
        );
      }
      const plan = replacementPlan(replacementOptions);
      const originalName = dockerContainerName(parsed.inspect);
      const backupContainerName = backupName(originalName, handle.bootstrapIdentity);
      const stagingName = replacementStagingName(originalName, handle.bootstrapIdentity);
      const existingJournal = deps.journalStore.load(handle.bootstrapIdentity);
      if (existingJournal) {
        assertDockerBootstrapTransactionAuthority(existingJournal, handle, snapshot);
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: existingJournal.bootstrapIdentity,
          runtimeId: existingJournal.replacementRuntimeId,
          detail: `preparation requires rollback or commit from durable phase ${existingJournal.phase}`,
        });
      }
      const trampolineCommand = replacementCommand(handle, snapshot);
      const cloneArgs = buildDockerGpuCloneRunArgs(parsed.inspect, plan.mode, {
        image: expectedImageReference(snapshot.image.repository, snapshot.image.manifestDigest),
        openshellSandboxCommand: handle.intendedWorkloadArgv,
        requiredUlimits: plan.requiredUlimits,
        extraGroupGids: plan.extraGroupGids,
        containerEntrypoint: MANAGED_BOOTSTRAP_TRAMPOLINE_EXECUTABLE,
        containerCommand: trampolineCommand,
        containerName: stagingName,
      });
      const options = {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      };

      let requestFile = "";
      let replacementRuntimeId = "";
      let stagedAuthority: DockerBootstrapTransaction | null = null;
      try {
        const created = deps.dockerRun(["create", ...cloneArgs], options);
        const returnedRuntimeId = String(created.stdout ?? "")
          .trim()
          .toLowerCase();
        let createdInspect: DockerContainerInspect;
        if (FULL_CONTAINER_ID_RE.test(returnedRuntimeId)) {
          replacementRuntimeId = returnedRuntimeId;
          createdInspect = inspectExact(replacementRuntimeId, deps);
        } else {
          try {
            createdInspect = inspectDockerContainerReference(stagingName, deps);
          } catch (lookupError) {
            throw new Error(
              "Managed bootstrap could not prove a stopped Docker replacement after create: " +
                (commandDetail(created) ||
                  (lookupError instanceof Error ? lookupError.message : String(lookupError))),
            );
          }
          replacementRuntimeId = String(createdInspect.Id ?? "").toLowerCase();
        }
        if (
          !FULL_CONTAINER_ID_RE.test(replacementRuntimeId) ||
          dockerContainerName(createdInspect) !== stagingName
        ) {
          throw new Error(
            "Managed bootstrap Docker create did not resolve one stopped identity-bound staging container.",
          );
        }
        assertExplicitlyStopped(createdInspect, "created replacement");
        const createdImageContentId = assertImage(createdInspect, snapshot.image, deps);
        if (createdImageContentId !== snapshot.runtimeImageContentId) {
          throw new Error(
            "Managed bootstrap Docker replacement resolved a different image content ID.",
          );
        }
        assertMetadata(createdInspect, handle.sandbox, snapshot.metadata);
        assertRootSupervisor(createdInspect);
        const intendedSandboxCommand = openshellSandboxCommandEnvValue(handle.intendedWorkloadArgv);
        if (!intendedSandboxCommand) {
          throw new Error(
            "Managed bootstrap Docker replacement requires one bounded intended workload argv.",
          );
        }
        assertReplacementBoundary(createdInspect, handle, snapshot);
        const expectedActivatedSpecHash = assertReplacementMatchesIntent(
          snapshot.specCanonicalJson,
          createdInspect,
          originalName,
          plan,
          intendedSandboxCommand,
        );
        const preparedSpec = normalizeDockerManagedBootstrapLaunchSpec(createdInspect);
        const expectedActivatedSpec = normalizeDockerManagedBootstrapLaunchSpec({
          ...createdInspect,
          Name: `/${originalName}`,
        });
        if (expectedActivatedSpec.hash !== expectedActivatedSpecHash) {
          throw new Error("Managed bootstrap Docker expected activation spec is inconsistent.");
        }
        stagedAuthority = Object.freeze({
          schemaVersion: DOCKER_MANAGED_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
          phase: "staged",
          bootstrapIdentity: handle.bootstrapIdentity,
          providerId: handle.sandbox.driverId,
          sandbox: Object.freeze({ ...handle.sandbox }),
          planFingerprint: createManagedBootstrapPlanFingerprint(handle.plan),
          profileFingerprint: handle.plan.profile.fingerprint,
          imageReference: expectedImageReference(
            snapshot.image.repository,
            snapshot.image.manifestDigest,
          ),
          runtimeImageContentId: snapshot.runtimeImageContentId,
          originalRuntimeId: snapshot.runtimeId,
          replacementRuntimeId,
          originalName,
          replacementStagingName: stagingName,
          backupName: backupContainerName,
          originalSpecHash: snapshot.specHash,
          replacementSpecHash: expectedActivatedSpecHash,
          rollbackTargetRuntimeId: snapshot.runtimeId,
          rollbackTargetSpecHash: snapshot.specHash,
          preparationReceipt: null,
          commitReceipt: null,
        });

        requestFile = writeProtectedEnvelope(handle.bootstrapIdentity, request);
        const copied = deps.dockerRun(
          ["cp", requestFile, replacementRuntimeId + ":" + MANAGED_BOOTSTRAP_REQUEST_FILE],
          options,
        );
        assertZero(
          copied,
          "Managed bootstrap could not stage its protected root-owned 0400 envelope",
        );

        const originalBeforeJournal = inspectExact(snapshot.runtimeId, deps);
        assertStableRunning(originalBeforeJournal, "pre-journal original");
        if (
          dockerContainerName(originalBeforeJournal) !== originalName ||
          normalizeDockerManagedBootstrapLaunchSpec(originalBeforeJournal).hash !==
            snapshot.specHash
        ) {
          throw new Error(
            "Managed bootstrap Docker original changed while the replacement was staged.",
          );
        }
        const replacementBeforeJournal = inspectExact(replacementRuntimeId, deps);
        assertTransactionReplacement(stagedAuthority, replacementBeforeJournal);
        const observedPreparedSpec =
          normalizeDockerManagedBootstrapLaunchSpec(replacementBeforeJournal);
        const observedActivatedSpec = normalizeDockerManagedBootstrapLaunchSpec({
          ...replacementBeforeJournal,
          Name: `/${originalName}`,
        });
        if (
          dockerContainerName(replacementBeforeJournal) !== stagingName ||
          observedPreparedSpec.canonicalJson !== preparedSpec.canonicalJson ||
          observedActivatedSpec.canonicalJson !== expectedActivatedSpec.canonicalJson
        ) {
          throw new Error("Managed bootstrap Docker replacement changed before durable staging.");
        }
        assertExplicitlyStopped(replacementBeforeJournal, "pre-journal replacement");

        return Object.freeze({
          schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
          sandbox: handle.sandbox,
          bootstrapIdentity: handle.bootstrapIdentity,
          originalRuntimeId: snapshot.runtimeId,
          preparedRuntimeId: replacementRuntimeId,
          image: snapshot.image,
          runtimeImageContentId: snapshot.runtimeImageContentId,
          originalSpecHash: snapshot.specHash,
          preparedSpecHash: preparedSpec.hash,
          preparedSpecCanonicalJson: preparedSpec.canonicalJson,
          expectedActivatedSpecHash,
          expectedActivatedSpecCanonicalJson: expectedActivatedSpec.canonicalJson,
          profileFingerprint: handle.plan.profile.fingerprint,
          rollbackAuthority: serializeDockerManagedBootstrapJournal(stagedAuthority),
        });
      } catch (error) {
        let rollbackError: unknown = null;
        try {
          const durable = deps.journalStore.load(handle.bootstrapIdentity);
          if (!durable) {
            cleanupUnjournaledPreparedContainer(
              { snapshot, preparedRuntimeId: replacementRuntimeId, stagingName },
              deps,
            );
          }
        } catch (cleanupError) {
          rollbackError = cleanupError;
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        if (rollbackError) attachManagedBootstrapRollbackError(failure, rollbackError);
        throw failure;
      } finally {
        if (requestFile) cleanupTempDir(requestFile, REQUEST_TEMP_PREFIX);
      }
    },
    async activateBootstrapReplacement({ handle, snapshot, prepared, durablePreparation }) {
      const authority = transactionFromPreparedAuthority(handle, snapshot, prepared);
      assertDurablePreparationAuthority(handle, snapshot, prepared, durablePreparation);
      const durableAuthority = Object.freeze({
        ...authority,
        preparationReceipt: durablePreparation,
      });
      const existingJournal = deps.journalStore.load(handle.bootstrapIdentity);
      if (existingJournal) {
        assertDockerBootstrapTransactionAuthority(
          existingJournal,
          handle,
          snapshot,
          prepared,
          null,
          durablePreparation,
        );
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: existingJournal.bootstrapIdentity,
          runtimeId: existingJournal.replacementRuntimeId,
          detail: `activation requires rollback or commit from durable phase ${existingJournal.phase}`,
        });
      }
      const options = {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      };
      try {
        const originalBeforeJournal = inspectExact(snapshot.runtimeId, deps);
        const preparedBeforeJournal = inspectExact(prepared.preparedRuntimeId, deps);
        assertTransactionOriginal(authority, originalBeforeJournal);
        assertTransactionReplacement(authority, preparedBeforeJournal);
        assertStableRunning(originalBeforeJournal, "pre-activation original");
        assertExplicitlyStopped(preparedBeforeJournal, "pre-activation replacement");
        if (
          dockerContainerName(originalBeforeJournal) !== authority.originalName ||
          dockerContainerName(preparedBeforeJournal) !== authority.replacementStagingName ||
          normalizeDockerManagedBootstrapLaunchSpec(preparedBeforeJournal).canonicalJson !==
            prepared.preparedSpecCanonicalJson
        ) {
          throw new Error(
            "Managed bootstrap Docker prepared runtimes changed before durable activation.",
          );
        }

        let journal = createDockerBootstrapJournalDurably(durableAuthority, deps);
        const originalAtFence = inspectExact(snapshot.runtimeId, deps);
        const replacementAtFence = inspectExact(prepared.preparedRuntimeId, deps);
        assertTransactionOriginal(journal, originalAtFence);
        assertTransactionReplacement(journal, replacementAtFence);
        if (
          dockerContainerName(originalAtFence) !== journal.originalName ||
          originalAtFence.State?.Running !== true ||
          dockerContainerName(replacementAtFence) !== journal.replacementStagingName ||
          normalizeDockerManagedBootstrapLaunchSpec(replacementAtFence).canonicalJson !==
            prepared.preparedSpecCanonicalJson
        ) {
          throw new Error(
            "Managed bootstrap Docker staged runtimes changed before the cutover fence.",
          );
        }
        assertExplicitlyStopped(replacementAtFence, "staged replacement");
        journal = transitionDockerBootstrapJournalDurably(journal, "cutover", deps);

        const stopped = deps.dockerStop(snapshot.runtimeId, {
          ...options,
          timeout: DOCKER_GPU_PATCH_STOP_TIMEOUT_MS,
        });
        const afterStop = inspectExact(snapshot.runtimeId, deps);
        assertTransactionOriginal(journal, afterStop);
        if (dockerContainerName(afterStop) !== journal.originalName) {
          throw new Error(
            "Managed bootstrap could not prove its exact original stopped after Docker stop: " +
              (commandDetail(stopped) || "state did not reach stopped"),
          );
        }
        assertExplicitlyStopped(afterStop, "stopped original");

        const renamedOriginal = deps.dockerRename(snapshot.runtimeId, journal.backupName, options);
        const afterOriginalRename = inspectExact(snapshot.runtimeId, deps);
        assertTransactionOriginal(journal, afterOriginalRename);
        if (dockerContainerName(afterOriginalRename) !== journal.backupName) {
          throw new Error(
            "Managed bootstrap could not prove its exact original backup rename: " +
              (commandDetail(renamedOriginal) || "name did not reach backup"),
          );
        }
        assertExplicitlyStopped(afterOriginalRename, "renamed rollback backup");

        const renamedReplacement = deps.dockerRename(
          prepared.preparedRuntimeId,
          journal.originalName,
          options,
        );
        const afterReplacementRename = inspectExact(prepared.preparedRuntimeId, deps);
        assertTransactionReplacement(journal, afterReplacementRename);
        if (dockerContainerName(afterReplacementRename) !== journal.originalName) {
          throw new Error(
            "Managed bootstrap could not prove its exact replacement cutover rename: " +
              (commandDetail(renamedReplacement) || "name did not reach target"),
          );
        }

        const started = deps.dockerStart(prepared.preparedRuntimeId, options);
        const running = inspectExact(prepared.preparedRuntimeId, deps);
        assertTransactionReplacement(journal, running);
        const runningSpec = normalizeDockerManagedBootstrapLaunchSpec(running);
        if (
          dockerContainerName(running) !== journal.originalName ||
          running.State?.Running !== true ||
          running.State.Paused === true ||
          running.State.Restarting === true ||
          running.State.Dead === true ||
          runningSpec.canonicalJson !== prepared.expectedActivatedSpecCanonicalJson
        ) {
          throw new Error(
            "Managed bootstrap could not prove its exact replacement running after Docker start: " +
              (commandDetail(started) || "state did not reach running"),
          );
        }
        assertReplacementBoundary(running, handle, snapshot);
        const preservedOriginal = inspectExact(snapshot.runtimeId, deps);
        assertTransactionOriginal(journal, preservedOriginal);
        if (dockerContainerName(preservedOriginal) !== journal.backupName) {
          throw new Error("Managed bootstrap Docker rollback backup changed during cutover.");
        }
        assertExplicitlyStopped(preservedOriginal, "preserved rollback backup");

        return Object.freeze({
          schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
          sandbox: handle.sandbox,
          bootstrapIdentity: handle.bootstrapIdentity,
          originalRuntimeId: snapshot.runtimeId,
          replacementRuntimeId: prepared.preparedRuntimeId,
          image: snapshot.image,
          runtimeImageContentId: snapshot.runtimeImageContentId,
          originalSpecHash: snapshot.specHash,
          replacementSpecHash: prepared.expectedActivatedSpecHash,
          replacementSpecCanonicalJson: prepared.expectedActivatedSpecCanonicalJson,
          profileFingerprint: handle.plan.profile.fingerprint,
        });
      } catch (error) {
        let rollbackError: unknown = null;
        try {
          if (!deps.journalStore.load(handle.bootstrapIdentity)) {
            cleanupUnjournaledPreparedContainer(
              {
                snapshot,
                preparedRuntimeId: prepared.preparedRuntimeId,
                stagingName: authority.replacementStagingName,
              },
              deps,
            );
          }
        } catch (cleanupError) {
          rollbackError = cleanupError;
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        if (rollbackError) attachManagedBootstrapRollbackError(failure, rollbackError);
        throw failure;
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
      const journal = reconstructDockerBootstrapTransaction(handle, snapshot, replacement, deps);
      if (journal.phase !== "cutover") {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: journal.bootstrapIdentity,
          runtimeId: journal.replacementRuntimeId,
          detail: `bootstrap completion is invalid from durable journal phase ${journal.phase}`,
        });
      }
      assertCompletedCutoverRuntimeState(journal, deps);
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
      const afterWaitJournal = deps.journalStore.load(journal.bootstrapIdentity);
      if (!afterWaitJournal || !sameDockerBootstrapJournal(afterWaitJournal, journal)) {
        throw new ManagedBootstrapCommitStateIndeterminateError({
          bootstrapIdentity: journal.bootstrapIdentity,
          runtimeId: journal.replacementRuntimeId,
          detail: "durable transaction authority changed while awaiting bootstrap",
        });
      }
      assertCompletedCutoverRuntimeState(afterWaitJournal, deps);
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
      if (afterWaitJournal.commitReceipt !== null) {
        if (
          afterWaitJournal.commitReceipt.transactionPending !== imageCompletion.transactionPending
        ) {
          throw new ManagedBootstrapCommitStateIndeterminateError({
            bootstrapIdentity: afterWaitJournal.bootstrapIdentity,
            runtimeId: afterWaitJournal.replacementRuntimeId,
            detail: "durable completion disagrees with the image-owned transaction receipt",
          });
        }
        return afterWaitJournal.commitReceipt;
      }
      const completion = Object.freeze({
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
      const completedJournal = recordDockerBootstrapCompletionDurably(
        afterWaitJournal,
        completion,
        deps,
      );
      if (completedJournal.commitReceipt === null) {
        throw new Error("Managed bootstrap Docker completion receipt disappeared after recording.");
      }
      return completedJournal.commitReceipt;
    },

    finalizeBootstrap,
  };
}
