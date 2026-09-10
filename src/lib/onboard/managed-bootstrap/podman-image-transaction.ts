// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import { cleanupTempDir, secureTempFile } from "../temp-files";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES,
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  type ManagedBootstrapImageCompletion,
  parseManagedBootstrapImageCompletion,
  serializeManagedBootstrapEnvelopeTar,
} from "./envelope";
import {
  normalizePodmanBootstrapJournal,
  type PodmanBootstrapJournal,
  type PodmanBootstrapJournalStore,
} from "./podman-bootstrap-journal";
import {
  PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
  PODMAN_BOOTSTRAP_STATE_DIRECTORY,
  type PodmanBootstrapPreparedReplacement,
} from "./podman-bootstrap-replacement";
import type { PodmanGatewayWatcherLease } from "./podman-watcher-lease";

export const PODMAN_BOOTSTRAP_IMAGE_TRANSACTION_SCHEMA_VERSION = 1 as const;

const COMPLETION_TEMP_PREFIX = "nemoclaw-podman-bootstrap-completion";
const START_LOG_TEMP_PREFIX = "nemoclaw-podman-bootstrap-start-log";
const START_LOG_PATH = "/tmp/nemoclaw-start.log";
const START_LOG_MAX_BYTES = 64 * 1024;
const FULL_RUNTIME_ID = /^[a-f0-9]{64}$/u;
const IMAGE_CONTENT_ID = /^sha256:[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/u;
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_TIMEOUT_SECONDS = 3_600;

type BootstrapEngine = ContainerEngine & { readonly authorityId: string };
type ManagedStartupAgent = ManagedStartupRootApplyRequest["agent"];

export interface PodmanBootstrapImageTransactionInput {
  readonly engine: BootstrapEngine;
  readonly journalStore: Pick<PodmanBootstrapJournalStore, "load">;
  readonly watcherLease: PodmanGatewayWatcherLease;
  readonly agent: ManagedStartupAgent;
  readonly prepared: PodmanBootstrapPreparedReplacement;
  readonly profileFingerprint: string;
  readonly request: ManagedStartupRootApplyRequest;
}

export interface PodmanBootstrapImageTransaction {
  readonly schemaVersion: typeof PODMAN_BOOTSTRAP_IMAGE_TRANSACTION_SCHEMA_VERSION;
  readonly agent: ManagedStartupAgent;
  readonly bootstrapIdentity: string;
  readonly engineAuthorityId: string;
  readonly originalRuntimeId: string;
  readonly profileFingerprint: string;
  readonly replacementRuntimeId: string;
  readonly replacementStagingName: string;
  readonly replacementStateVolumeName: string;
  readonly replacementStateVolumeMountpoint: string;
  readonly replacementImageContentId: string;
  readonly replacementSpecFingerprint: string;
  readonly watcherLeaseId: string;
  readonly startedAt: string;
}

export interface PodmanBootstrapImageTransactionCompletion extends ManagedBootstrapImageCompletion {
  readonly engineAuthorityId: string;
  readonly originalRuntimeId: string;
  readonly replacementRuntimeId: string;
  readonly replacementStagingName: string;
  readonly replacementStateVolumeName: string;
  readonly replacementStateVolumeMountpoint: string;
  readonly replacementImageContentId: string;
  readonly replacementSpecFingerprint: string;
  readonly watcherLeaseId: string;
  readonly completedAt: string;
}

export interface PodmanBootstrapImageTransactionDeps {
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => void;
  readonly pollIntervalMs?: number;
}

interface ExactPodmanContainerState {
  readonly error: string;
  readonly exitCode: number | null;
  readonly imageContentId: string;
  readonly name: string;
  readonly oomKilled: boolean | null;
  readonly runtimeId: string;
  readonly running: boolean;
  readonly status: string;
  readonly stateVolumeMountpoint: string;
  readonly stateVolumeName: string;
}

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`Podman managed bootstrap image transaction failed: ${message}`);
}

function exactEngine(engine: BootstrapEngine, expectedAuthorityId?: string): BootstrapEngine {
  if (
    engine.engineId !== "podman" ||
    engine.operation !== "managed-bootstrap" ||
    typeof engine.authorityId !== "string" ||
    !/^podman-sha256:[a-f0-9]{64}$/u.test(engine.authorityId) ||
    (expectedAuthorityId !== undefined && engine.authorityId !== expectedAuthorityId)
  ) {
    fail("the exact Podman managed-bootstrap engine authority is unavailable");
  }
  return engine;
}

function exactAgent(value: string): ManagedStartupAgent {
  if (!SAFE_AGENT_ID.test(value)) fail("the managed agent identity is invalid");
  return value as ManagedStartupAgent;
}

function exactSha256(value: string, label: string): string {
  if (!SHA256.test(value)) fail(`${label} must be lowercase SHA-256`);
  return value;
}

function exactRuntimeId(value: string): string {
  if (!FULL_RUNTIME_ID.test(value)) fail("replacement runtime ID must be a full lowercase ID");
  return value;
}

function exactImageContentId(value: string): string {
  if (!IMAGE_CONTENT_ID.test(value)) {
    fail("replacement image identity must be one immutable content ID");
  }
  return value;
}

function exactName(value: string, label: string): string {
  if (!SAFE_NAME.test(value)) fail(`${label} must be one exact Podman name`);
  return value;
}

function exactMountpoint(value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value === path.parse(value).root
  ) {
    fail("replacement state-volume mountpoint must be one normalized non-root absolute path");
  }
  return value;
}

function sameJournal(left: PodmanBootstrapJournal, right: PodmanBootstrapJournal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactPreparedAuthority(
  input: Pick<
    PodmanBootstrapImageTransactionInput,
    "engine" | "journalStore" | "prepared" | "watcherLease"
  >,
): PodmanBootstrapPreparedReplacement {
  const prepared = input.prepared;
  if (
    !prepared ||
    typeof prepared !== "object" ||
    prepared.schemaVersion !== PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION
  ) {
    return fail("the prepared replacement authority is invalid");
  }
  exactSha256(prepared.bootstrapIdentity, "bootstrap identity");
  exactRuntimeId(prepared.originalRuntimeId);
  exactRuntimeId(prepared.replacementRuntimeId);
  exactImageContentId(prepared.replacementImageContentId);
  exactSha256(prepared.replacementSpecFingerprint, "replacement specification fingerprint");
  exactName(prepared.replacementStagingName, "replacement staging name");
  exactName(prepared.replacementStateVolumeName, "replacement state-volume name");
  exactMountpoint(prepared.replacementStateVolumeMountpoint);
  const expectedJournal = normalizePodmanBootstrapJournal(prepared.journal);
  const loaded = input.journalStore.load(prepared.bootstrapIdentity);
  if (!loaded) return fail("the durable prepared-replacement journal is unavailable");
  const journal = normalizePodmanBootstrapJournal(loaded);
  if (
    journal.phase !== "original-stopped" ||
    !sameJournal(journal, expectedJournal) ||
    journal.engineAuthorityId !== input.engine.authorityId ||
    journal.watcherLeaseId !== input.watcherLease.record.leaseId ||
    journal.originalRuntimeId !== prepared.originalRuntimeId ||
    journal.replacementRuntimeId !== prepared.replacementRuntimeId ||
    journal.replacementStagingName !== prepared.replacementStagingName ||
    journal.replacementStateVolumeName !== prepared.replacementStateVolumeName ||
    journal.replacementStateVolumeMountpoint !== prepared.replacementStateVolumeMountpoint ||
    journal.replacementImageContentId !== prepared.replacementImageContentId ||
    journal.replacementSpecFingerprint !== prepared.replacementSpecFingerprint
  ) {
    return fail("the prepared replacement does not match its exact original-stopped authority");
  }
  return prepared;
}

function exactWatcherLease(lease: PodmanGatewayWatcherLease, expectedLeaseId?: string): void {
  if (
    !lease ||
    typeof lease !== "object" ||
    (lease.record?.phase !== "stopped" && lease.record?.phase !== "observing") ||
    (expectedLeaseId !== undefined && lease.record.leaseId !== expectedLeaseId)
  ) {
    fail("the exact OpenShell watcher transaction lease is unavailable");
  }
  lease.assertStillHeld();
}

function commandFailure(result: ContainerEngineCommandResult, action: string): never {
  const detail = result.error?.message.trim().slice(0, 400);
  fail(`${action} returned status ${String(result.status)}${detail ? `: ${detail}` : ""}`);
}

function capture(
  engine: BootstrapEngine,
  args: readonly string[],
  action: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  input?: Buffer,
): ContainerEngineCommandResult {
  const result = engine.capture(args, timeoutMs, input);
  if (result.status !== 0) commandFailure(result, action);
  return result;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function normalizedRuntimeId(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} is missing`);
  const match = /^(?:sha256:)?([a-f0-9]{64})$/u.exec(value);
  if (!match?.[1]) fail(`${label} must be one full immutable ID`);
  return match[1];
}

function exactString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return fail(`${label} must be one exact string`);
  }
  return value;
}

function exactStringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return fail(`${label} must be an array of strings`);
  }
  return Object.freeze([...(value as string[])]);
}

function exactStateVolume(
  inspect: JsonRecord,
  prepared: PodmanBootstrapPreparedReplacement,
): Pick<ExactPodmanContainerState, "stateVolumeMountpoint" | "stateVolumeName"> {
  if (!Array.isArray(inspect.Mounts)) {
    return fail("Podman replacement inspect Mounts must be an array");
  }
  const mounts = inspect.Mounts.map((entry, index) =>
    record(entry, `Podman replacement mount ${String(index)}`),
  ).filter((entry) => entry.Destination === PODMAN_BOOTSTRAP_STATE_DIRECTORY);
  if (mounts.length !== 1) {
    return fail("the exact replacement state-volume mount is unavailable");
  }
  const mount = mounts[0] as JsonRecord;
  const mode = exactString(mount.Mode, "Podman replacement state-volume mode", true);
  const options = exactStringArray(mount.Options, "Podman replacement state-volume options");
  const propagation = exactString(
    mount.Propagation,
    "Podman replacement state-volume propagation",
    true,
  );
  const modeTokens = new Set(mode.split(",").filter(Boolean));
  if (
    mount.Type !== "volume" ||
    mount.Name !== prepared.replacementStateVolumeName ||
    mount.Source !== prepared.replacementStateVolumeMountpoint ||
    mount.Driver !== "local" ||
    mount.RW !== true ||
    !["", "rprivate"].includes(propagation) ||
    modeTokens.has("Z") ||
    modeTokens.has("ro") ||
    options.some((option) => option === "ro" || option === "readonly")
  ) {
    return fail("the exact replacement state-volume authority changed");
  }
  return Object.freeze({
    stateVolumeMountpoint: prepared.replacementStateVolumeMountpoint,
    stateVolumeName: prepared.replacementStateVolumeName,
  });
}

function parseInspect(
  text: string,
  prepared: PodmanBootstrapPreparedReplacement,
): ExactPodmanContainerState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("Podman inspect returned unreadable JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    return fail("Podman inspect did not return exactly one replacement");
  }
  const inspect = record(parsed[0], "Podman replacement inspect");
  const runtimeId = normalizedRuntimeId(inspect.Id, "Podman replacement runtime ID");
  const imageContentId = `sha256:${normalizedRuntimeId(
    inspect.Image,
    "Podman replacement image content ID",
  )}`;
  const name = exactString(inspect.Name, "Podman replacement name");
  if (
    runtimeId !== prepared.replacementRuntimeId ||
    imageContentId !== prepared.replacementImageContentId ||
    name !== prepared.replacementStagingName
  ) {
    return fail("the exact replacement runtime, image, or name identity changed");
  }
  const stateVolume = exactStateVolume(inspect, prepared);
  const state = record(inspect.State, "Podman replacement state");
  if (
    typeof state.Running !== "boolean" ||
    (state.Paused !== undefined && typeof state.Paused !== "boolean") ||
    (state.Restarting !== undefined && typeof state.Restarting !== "boolean") ||
    (state.Dead !== undefined && typeof state.Dead !== "boolean") ||
    state.Paused === true ||
    state.Restarting === true ||
    state.Dead === true
  ) {
    return fail("the exact replacement is not in a stable running or stopped state");
  }
  const exitCode =
    typeof state.ExitCode === "number" && Number.isSafeInteger(state.ExitCode)
      ? state.ExitCode
      : null;
  const oomKilled = typeof state.OOMKilled === "boolean" ? state.OOMKilled : null;
  const status =
    typeof state.Status === "string" && state.Status.length <= 64 && !/[\r\n\0]/u.test(state.Status)
      ? state.Status
      : "unknown";
  const error =
    typeof state.Error === "string" ? state.Error.replace(/\s+/gu, " ").trim().slice(-300) : "";
  return Object.freeze({
    error,
    exitCode,
    imageContentId,
    name,
    oomKilled,
    runtimeId,
    running: state.Running,
    status,
    ...stateVolume,
  });
}

function inspectExact(
  engine: BootstrapEngine,
  prepared: PodmanBootstrapPreparedReplacement,
): ExactPodmanContainerState {
  return parseInspect(
    capture(
      engine,
      ["container", "inspect", prepared.replacementRuntimeId],
      "exact replacement inspection",
    ).stdout,
    prepared,
  );
}

function sameState(left: ExactPodmanContainerState, right: ExactPodmanContainerState): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.imageContentId === right.imageContentId &&
    left.name === right.name &&
    left.running === right.running &&
    left.status === right.status &&
    left.exitCode === right.exitCode &&
    left.error === right.error &&
    left.oomKilled === right.oomKilled &&
    left.stateVolumeMountpoint === right.stateVolumeMountpoint &&
    left.stateVolumeName === right.stateVolumeName
  );
}

function safeBootstrapFailureLine(output: string): string | null {
  const allowed = output.split(/\r?\n/u).flatMap((line) => {
    if (!/^[\x20-\x7e]+$/u.test(line)) return [];
    const boundedPrefix =
      /^(?:(?:\[SECURITY\] Managed bootstrap (?:entrypoint|trampoline)|Managed startup (?:image application|shared-state transaction) failed): |\[SECURITY\] (?:Refusing Hermes startup because |Config integrity check failed|HERMES_[A-Z0-9_]+: ))/u.test(
        line,
      );
    const exactFixedFailure =
      /^(?:\[SECURITY\] (?:Required entrypoint env-wrapper normalizer is missing|Managed startup env wrapper has too many assignments|Managed startup env wrapper contains a malformed assignment|Required runtime state mutation startup gate is unavailable|Runtime state mutation startup gate failed|Managed DCode login profile is missing or unsafe|Could not protect the managed DCode login profile|DCode login profile is not protected; rebuild this sandbox)\.|runtime-state-mutation-startup-gate: held)$/u.test(
        line,
      );
    if (!boundedPrefix && !exactFixedFailure) {
      return [];
    }
    return [line.slice(0, 400)];
  });
  return allowed.at(-1) ?? null;
}

function boundedBootstrapStartLogFailure(
  engine: BootstrapEngine,
  runtimeId: string,
): string | null {
  const file = secureTempFile(START_LOG_TEMP_PREFIX, ".log");
  let descriptor: number | null = null;
  try {
    const copied = engine.capture(
      ["container", "cp", `${runtimeId}:${START_LOG_PATH}`, file],
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    if (copied.status !== 0 || copied.error) return null;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > START_LOG_MAX_BYTES) {
      return null;
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return null;
    const output = fs.readFileSync(descriptor, "utf8");
    return Buffer.byteLength(output) === stat.size ? safeBootstrapFailureLine(output) : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    cleanupTempDir(file, START_LOG_TEMP_PREFIX);
  }
}

function boundedBootstrapSecurityFailure(
  engine: BootstrapEngine,
  runtimeId: string,
): string | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = engine.capture(
      ["container", "logs", "--tail", "80", runtimeId],
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    const containerLogFailure =
      result.status === 0 && !result.error
        ? safeBootstrapFailureLine(`${result.stdout}\n${result.stderr}`)
        : null;
    if (containerLogFailure) return containerLogFailure;
    if (attempt < 2) defaultSleep(100);
  }
  return boundedBootstrapStartLogFailure(engine, runtimeId);
}

function inspectStable(
  engine: BootstrapEngine,
  prepared: PodmanBootstrapPreparedReplacement,
  expectedRunning: boolean,
): ExactPodmanContainerState {
  const first = inspectExact(engine, prepared);
  const second = inspectExact(engine, prepared);
  if (!sameState(first, second) || second.running !== expectedRunning) {
    const bootstrapFailure =
      expectedRunning && !second.running
        ? boundedBootstrapSecurityFailure(engine, prepared.replacementRuntimeId)
        : null;
    const detail = [
      `status ${second.status}`,
      `exit ${second.exitCode === null ? "unknown" : String(second.exitCode)}`,
      `oom ${second.oomKilled === null ? "unknown" : String(second.oomKilled)}`,
      ...(second.error ? [`error ${second.error}`] : []),
      ...(bootstrapFailure ? [`bootstrap ${bootstrapFailure}`] : []),
    ].join("; ");
    fail(
      `the exact replacement is not stably ${expectedRunning ? "running" : "stopped"} (${detail})`,
    );
  }
  return second;
}

function stageProtectedEnvelope(
  input: PodmanBootstrapImageTransactionInput,
  prepared: PodmanBootstrapPreparedReplacement,
): void {
  const archive = serializeManagedBootstrapEnvelopeTar({
    bootstrapIdentity: prepared.bootstrapIdentity,
    rootApplyRequest: input.request,
  });
  capture(
    input.engine,
    ["container", "cp", "-", `${prepared.replacementRuntimeId}:/`],
    "protected root request staging",
    DEFAULT_COMMAND_TIMEOUT_MS,
    archive,
  );
}

function sameStableMetadata(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readProtectedCompletion(file: string): ManagedBootstrapImageCompletion {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") fail("O_NOFOLLOW is unavailable for completion reads");
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonblock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return fail("the copied completion ownership boundary is invalid");
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      Number(before.mode & 0o777n) !== 0o444 ||
      before.size < 1n ||
      before.size > BigInt(MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES)
    ) {
      return fail("the image completion is not one protected bounded 0444 file");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    const overflowCount = fs.readSync(descriptor, overflow, 0, 1, offset);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || overflowCount !== 0 || !sameStableMetadata(before, after)) {
      return fail("the image completion changed during its stable read");
    }
    return parseManagedBootstrapImageCompletion(bytes.toString("utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function tryCopyCompletion(
  engine: BootstrapEngine,
  runtimeId: string,
): { readonly completion: ManagedBootstrapImageCompletion | null; readonly status: number } {
  const file = secureTempFile(COMPLETION_TEMP_PREFIX, ".json");
  try {
    const result = engine.capture(
      ["container", "cp", `${runtimeId}:${MANAGED_BOOTSTRAP_COMPLETION_FILE}`, file],
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    if (result.status !== 0) return { completion: null, status: result.status };
    try {
      return { completion: readProtectedCompletion(file), status: result.status };
    } catch (error) {
      // Podman can report a successful archive copy before its destination is
      // visible to the host caller. Treat only that absent destination as an
      // unpublished receipt and retain the existing bounded poll. All unsafe
      // metadata and unstable-read failures remain fatal.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { completion: null, status: result.status };
      }
      throw error;
    }
  } finally {
    cleanupTempDir(file, COMPLETION_TEMP_PREFIX);
  }
}

function defaultSleep(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function timeoutMilliseconds(timeoutSecs: number): number {
  if (!Number.isSafeInteger(timeoutSecs) || timeoutSecs < 1 || timeoutSecs > MAX_TIMEOUT_SECONDS) {
    fail(`completion timeout must be an integer from 1 to ${String(MAX_TIMEOUT_SECONDS)} seconds`);
  }
  return timeoutSecs * 1_000;
}

function pollInterval(deps: PodmanBootstrapImageTransactionDeps): number {
  const value = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    fail("completion polling interval must be an integer from 1 to 10000 milliseconds");
  }
  return value;
}

function assertInput(
  input: PodmanBootstrapImageTransactionInput,
): PodmanBootstrapPreparedReplacement {
  exactEngine(input.engine);
  exactWatcherLease(input.watcherLease);
  exactAgent(input.agent);
  exactSha256(input.profileFingerprint, "profile fingerprint");
  if (
    input.request.agent !== input.agent ||
    input.request.profileFingerprint !== input.profileFingerprint
  ) {
    fail("the root request does not match its exact agent and profile authority");
  }
  return exactPreparedAuthority(input);
}

/**
 * Stage one identity-bound request into the stopped writable layer, then start
 * that exact replacement. The image-owned trampoline remains the only root
 * application boundary; this host path never enters a container process.
 */
export function startPodmanBootstrapImageTransaction(
  input: PodmanBootstrapImageTransactionInput,
  deps: Pick<PodmanBootstrapImageTransactionDeps, "now"> = {},
): PodmanBootstrapImageTransaction {
  const prepared = assertInput(input);
  inspectStable(input.engine, prepared, false);
  exactWatcherLease(input.watcherLease);
  exactPreparedAuthority(input);
  stageProtectedEnvelope(input, prepared);
  exactWatcherLease(input.watcherLease);
  exactPreparedAuthority(input);
  inspectStable(input.engine, prepared, false);
  capture(
    input.engine,
    ["container", "start", prepared.replacementRuntimeId],
    "exact replacement start",
    DEFAULT_START_TIMEOUT_MS,
  );
  exactWatcherLease(input.watcherLease);
  exactPreparedAuthority(input);
  inspectStable(input.engine, prepared, true);
  exactWatcherLease(input.watcherLease);
  exactPreparedAuthority(input);
  return Object.freeze({
    schemaVersion: PODMAN_BOOTSTRAP_IMAGE_TRANSACTION_SCHEMA_VERSION,
    agent: input.agent,
    bootstrapIdentity: prepared.bootstrapIdentity,
    engineAuthorityId: input.engine.authorityId,
    originalRuntimeId: prepared.originalRuntimeId,
    profileFingerprint: input.profileFingerprint,
    replacementRuntimeId: prepared.replacementRuntimeId,
    replacementStagingName: prepared.replacementStagingName,
    replacementStateVolumeName: prepared.replacementStateVolumeName,
    replacementStateVolumeMountpoint: prepared.replacementStateVolumeMountpoint,
    replacementImageContentId: prepared.replacementImageContentId,
    replacementSpecFingerprint: prepared.replacementSpecFingerprint,
    watcherLeaseId: input.watcherLease.record.leaseId,
    startedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
}

/** Poll one protected image-owned completion while exact watcher authority stays held. */
export function awaitPodmanBootstrapImageTransaction(
  input: {
    readonly engine: BootstrapEngine;
    readonly journalStore: Pick<PodmanBootstrapJournalStore, "load">;
    readonly prepared: PodmanBootstrapPreparedReplacement;
    readonly watcherLease: PodmanGatewayWatcherLease;
    readonly transaction: PodmanBootstrapImageTransaction;
    readonly timeoutSecs: number;
  },
  deps: PodmanBootstrapImageTransactionDeps = {},
): PodmanBootstrapImageTransactionCompletion {
  const transaction = input.transaction;
  if (
    transaction.schemaVersion !== PODMAN_BOOTSTRAP_IMAGE_TRANSACTION_SCHEMA_VERSION ||
    exactAgent(transaction.agent) !== transaction.agent
  ) {
    return fail("the started transaction receipt is invalid");
  }
  exactEngine(input.engine, transaction.engineAuthorityId);
  exactWatcherLease(input.watcherLease, transaction.watcherLeaseId);
  exactSha256(transaction.bootstrapIdentity, "bootstrap identity");
  exactSha256(transaction.profileFingerprint, "profile fingerprint");
  exactRuntimeId(transaction.originalRuntimeId);
  exactRuntimeId(transaction.replacementRuntimeId);
  exactName(transaction.replacementStagingName, "replacement staging name");
  exactName(transaction.replacementStateVolumeName, "replacement state-volume name");
  exactMountpoint(transaction.replacementStateVolumeMountpoint);
  exactImageContentId(transaction.replacementImageContentId);
  exactSha256(transaction.replacementSpecFingerprint, "replacement specification fingerprint");
  const prepared = exactPreparedAuthority(input);
  if (
    transaction.bootstrapIdentity !== prepared.bootstrapIdentity ||
    transaction.originalRuntimeId !== prepared.originalRuntimeId ||
    transaction.replacementRuntimeId !== prepared.replacementRuntimeId ||
    transaction.replacementStagingName !== prepared.replacementStagingName ||
    transaction.replacementStateVolumeName !== prepared.replacementStateVolumeName ||
    transaction.replacementStateVolumeMountpoint !== prepared.replacementStateVolumeMountpoint ||
    transaction.replacementImageContentId !== prepared.replacementImageContentId ||
    transaction.replacementSpecFingerprint !== prepared.replacementSpecFingerprint
  ) {
    return fail("the started transaction does not match its prepared replacement authority");
  }
  const timeoutMs = timeoutMilliseconds(input.timeoutSecs);
  const intervalMs = pollInterval(deps);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now().getTime() + timeoutMs;
  let lastCopyStatus: number | null = null;

  while (true) {
    exactWatcherLease(input.watcherLease, transaction.watcherLeaseId);
    exactPreparedAuthority(input);
    inspectStable(input.engine, prepared, true);
    const copied = tryCopyCompletion(input.engine, transaction.replacementRuntimeId);
    lastCopyStatus = copied.status;
    if (copied.completion) {
      const completion = copied.completion;
      if (
        completion.agent !== transaction.agent ||
        completion.bootstrapIdentity !== transaction.bootstrapIdentity ||
        completion.profileFingerprint !== transaction.profileFingerprint
      ) {
        return fail("the image completion does not match its exact transaction authority");
      }
      inspectStable(input.engine, prepared, true);
      exactWatcherLease(input.watcherLease, transaction.watcherLeaseId);
      exactPreparedAuthority(input);
      return Object.freeze({
        ...completion,
        engineAuthorityId: transaction.engineAuthorityId,
        originalRuntimeId: transaction.originalRuntimeId,
        replacementRuntimeId: transaction.replacementRuntimeId,
        replacementStagingName: transaction.replacementStagingName,
        replacementStateVolumeName: transaction.replacementStateVolumeName,
        replacementStateVolumeMountpoint: transaction.replacementStateVolumeMountpoint,
        replacementImageContentId: transaction.replacementImageContentId,
        replacementSpecFingerprint: transaction.replacementSpecFingerprint,
        watcherLeaseId: transaction.watcherLeaseId,
        completedAt: now().toISOString(),
      });
    }
    if (now().getTime() >= deadline) {
      return fail(
        `protected image completion was not published before timeout (last copy status ${String(
          lastCopyStatus,
        )})`,
      );
    }
    sleep(intervalMs);
  }
}
