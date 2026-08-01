// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import { MANAGED_STARTUP_AGENTS, type ManagedStartupAgent } from "../managed-startup/profile";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import { cleanupTempDir, secureTempFile } from "../temp-files";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES,
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  type ManagedBootstrapImageCompletion,
  parseManagedBootstrapImageCompletion,
  serializeManagedBootstrapEnvelope,
} from "./envelope";
import type { PodmanGatewayWatcherLease } from "./podman-watcher-lease";

export const PODMAN_BOOTSTRAP_IMAGE_TRANSACTION_SCHEMA_VERSION = 1 as const;

const REQUEST_TEMP_PREFIX = "nemoclaw-podman-bootstrap-request";
const COMPLETION_TEMP_PREFIX = "nemoclaw-podman-bootstrap-completion";
const FULL_RUNTIME_ID = /^[a-f0-9]{64}$/u;
const IMAGE_CONTENT_ID = /^sha256:[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_TIMEOUT_SECONDS = 3_600;

type BootstrapEngine = ContainerEngine & { readonly authorityId: string };

export interface PodmanBootstrapImageTransactionInput {
  readonly engine: BootstrapEngine;
  readonly watcherLease: PodmanGatewayWatcherLease;
  readonly agent: ManagedStartupAgent;
  readonly bootstrapIdentity: string;
  readonly profileFingerprint: string;
  readonly replacementRuntimeId: string;
  readonly replacementImageContentId: string;
  readonly request: ManagedStartupRootApplyRequest;
}

export interface PodmanBootstrapImageTransaction {
  readonly schemaVersion: typeof PODMAN_BOOTSTRAP_IMAGE_TRANSACTION_SCHEMA_VERSION;
  readonly agent: ManagedStartupAgent;
  readonly bootstrapIdentity: string;
  readonly engineAuthorityId: string;
  readonly profileFingerprint: string;
  readonly replacementRuntimeId: string;
  readonly replacementImageContentId: string;
  readonly watcherLeaseId: string;
  readonly startedAt: string;
}

export interface PodmanBootstrapImageTransactionCompletion extends ManagedBootstrapImageCompletion {
  readonly engineAuthorityId: string;
  readonly replacementRuntimeId: string;
  readonly replacementImageContentId: string;
  readonly watcherLeaseId: string;
  readonly completedAt: string;
}

export interface PodmanBootstrapImageTransactionDeps {
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => void;
  readonly pollIntervalMs?: number;
}

interface ExactPodmanContainerState {
  readonly imageContentId: string;
  readonly runtimeId: string;
  readonly running: boolean;
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
  if ((MANAGED_STARTUP_AGENTS as readonly string[]).includes(value)) {
    return value as ManagedStartupAgent;
  }
  return fail("the managed agent is unsupported");
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

function exactWatcherLease(lease: PodmanGatewayWatcherLease, expectedLeaseId?: string): void {
  if (
    !lease ||
    typeof lease !== "object" ||
    lease.record?.phase !== "stopped" ||
    (expectedLeaseId !== undefined && lease.record.leaseId !== expectedLeaseId)
  ) {
    fail("the exact stopped OpenShell watcher lease is unavailable");
  }
  lease.assertStillStopped();
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
): ContainerEngineCommandResult {
  const result = engine.capture(args, timeoutMs);
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

function parseInspect(
  text: string,
  expectedRuntimeId: string,
  expectedImageContentId: string,
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
  if (runtimeId !== expectedRuntimeId || imageContentId !== expectedImageContentId) {
    return fail("the exact replacement runtime or image identity changed");
  }
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
  return Object.freeze({ imageContentId, runtimeId, running: state.Running });
}

function inspectExact(
  engine: BootstrapEngine,
  runtimeId: string,
  imageContentId: string,
): ExactPodmanContainerState {
  return parseInspect(
    capture(engine, ["container", "inspect", runtimeId], "exact replacement inspection").stdout,
    runtimeId,
    imageContentId,
  );
}

function sameState(left: ExactPodmanContainerState, right: ExactPodmanContainerState): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.imageContentId === right.imageContentId &&
    left.running === right.running
  );
}

function inspectStable(
  engine: BootstrapEngine,
  runtimeId: string,
  imageContentId: string,
  expectedRunning: boolean,
): ExactPodmanContainerState {
  const first = inspectExact(engine, runtimeId, imageContentId);
  const second = inspectExact(engine, runtimeId, imageContentId);
  if (!sameState(first, second) || second.running !== expectedRunning) {
    fail(`the exact replacement is not stably ${expectedRunning ? "running" : "stopped"}`);
  }
  return second;
}

function writeProtectedEnvelope(input: PodmanBootstrapImageTransactionInput): string {
  const file = secureTempFile(REQUEST_TEMP_PREFIX, ".json");
  try {
    fs.writeFileSync(
      file,
      serializeManagedBootstrapEnvelope({
        bootstrapIdentity: input.bootstrapIdentity,
        rootApplyRequest: input.request,
      }),
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
      fail("the root request source is not one protected 0400 file");
    }
    return file;
  } catch (error) {
    cleanupTempDir(file, REQUEST_TEMP_PREFIX);
    throw error;
  }
}

function stageProtectedEnvelope(input: PodmanBootstrapImageTransactionInput): void {
  const file = writeProtectedEnvelope(input);
  try {
    capture(
      input.engine,
      ["container", "cp", file, `${input.replacementRuntimeId}:${MANAGED_BOOTSTRAP_REQUEST_FILE}`],
      "protected root request staging",
    );
  } finally {
    cleanupTempDir(file, REQUEST_TEMP_PREFIX);
  }
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
    return { completion: readProtectedCompletion(file), status: result.status };
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

function assertInput(input: PodmanBootstrapImageTransactionInput): void {
  exactEngine(input.engine);
  exactWatcherLease(input.watcherLease);
  exactAgent(input.agent);
  exactSha256(input.bootstrapIdentity, "bootstrap identity");
  exactSha256(input.profileFingerprint, "profile fingerprint");
  exactRuntimeId(input.replacementRuntimeId);
  exactImageContentId(input.replacementImageContentId);
  if (
    input.request.agent !== input.agent ||
    input.request.profileFingerprint !== input.profileFingerprint
  ) {
    fail("the root request does not match its exact agent and profile authority");
  }
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
  assertInput(input);
  inspectStable(input.engine, input.replacementRuntimeId, input.replacementImageContentId, false);
  exactWatcherLease(input.watcherLease);
  stageProtectedEnvelope(input);
  exactWatcherLease(input.watcherLease);
  inspectStable(input.engine, input.replacementRuntimeId, input.replacementImageContentId, false);
  capture(
    input.engine,
    ["container", "start", input.replacementRuntimeId],
    "exact replacement start",
    DEFAULT_START_TIMEOUT_MS,
  );
  exactWatcherLease(input.watcherLease);
  inspectStable(input.engine, input.replacementRuntimeId, input.replacementImageContentId, true);
  exactWatcherLease(input.watcherLease);
  return Object.freeze({
    schemaVersion: PODMAN_BOOTSTRAP_IMAGE_TRANSACTION_SCHEMA_VERSION,
    agent: input.agent,
    bootstrapIdentity: input.bootstrapIdentity,
    engineAuthorityId: input.engine.authorityId,
    profileFingerprint: input.profileFingerprint,
    replacementRuntimeId: input.replacementRuntimeId,
    replacementImageContentId: input.replacementImageContentId,
    watcherLeaseId: input.watcherLease.record.leaseId,
    startedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
}

/** Poll one protected image-owned completion while the exact watcher stays stopped. */
export function awaitPodmanBootstrapImageTransaction(
  input: {
    readonly engine: BootstrapEngine;
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
  exactRuntimeId(transaction.replacementRuntimeId);
  exactImageContentId(transaction.replacementImageContentId);
  const timeoutMs = timeoutMilliseconds(input.timeoutSecs);
  const intervalMs = pollInterval(deps);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now().getTime() + timeoutMs;
  let lastCopyStatus: number | null = null;

  while (true) {
    exactWatcherLease(input.watcherLease, transaction.watcherLeaseId);
    inspectStable(
      input.engine,
      transaction.replacementRuntimeId,
      transaction.replacementImageContentId,
      true,
    );
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
      inspectStable(
        input.engine,
        transaction.replacementRuntimeId,
        transaction.replacementImageContentId,
        true,
      );
      exactWatcherLease(input.watcherLease, transaction.watcherLeaseId);
      return Object.freeze({
        ...completion,
        engineAuthorityId: transaction.engineAuthorityId,
        replacementRuntimeId: transaction.replacementRuntimeId,
        replacementImageContentId: transaction.replacementImageContentId,
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
