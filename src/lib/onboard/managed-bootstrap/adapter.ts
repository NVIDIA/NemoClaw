// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes as defaultRandomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  MANAGED_STARTUP_EXECUTABLE,
  MANAGED_STARTUP_HOLD_EXECUTABLE,
} from "../managed-startup/hold";
import type { ManagedStartupAgent } from "../managed-startup/profile";
import type { ManagedStartupStateRoot } from "../managed-startup/state-roots";
import {
  type ManagedStartupRootApplyRequest,
  parseManagedStartupRootApplyRequest,
  serializeManagedStartupRootApplyRequest,
} from "../managed-startup/root-apply";

export const MANAGED_BOOTSTRAP_SCHEMA_VERSION = 1 as const;
export const MANAGED_BOOTSTRAP_IDENTITY_BYTES = 32;
export const MANAGED_BOOTSTRAP_IDENTITY_ENV = "NEMOCLAW_MANAGED_BOOTSTRAP_IDENTITY";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const MANIFEST_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const MAX_MANAGED_BOOTSTRAP_RECOVERY_RECORDS = 4096;
const PROCESS_INJECTION_ENV_KEYS = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "ENV",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PS4",
  "SHELLOPTS",
]);
const PROCESS_INJECTION_ENV_PREFIXES = ["BASH_FUNC_"] as const;

export interface ManagedBootstrapImageIdentity {
  readonly repository: string;
  /** Registry/platform manifest digest, not a runtime-specific image config ID. */
  readonly manifestDigest: `sha256:${string}`;
}

export interface ManagedBootstrapSandboxIdentity {
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly driverId: string;
}

export interface ManagedBootstrapAgentIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly workdir: string;
}

export interface ManagedBootstrapExpectedPlan {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly sandboxName: string;
  readonly driverId: string;
  readonly image: ManagedBootstrapImageIdentity;
  readonly profile: {
    readonly agent: ManagedStartupAgent;
    readonly fingerprint: string;
  };
  readonly agentIdentity: ManagedBootstrapAgentIdentity;
  readonly managedStateRoots: readonly ManagedStartupStateRoot[];
  readonly intendedWorkloadArgv: readonly string[];
  readonly expectedSupervisorArgv: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ManagedBootstrapCreateReceipt {
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly ready: true;
  readonly readyAt: string;
}

export interface ManagedBootstrapCreateInput {
  readonly plan: ManagedBootstrapExpectedPlan;
  readonly request: ManagedStartupRootApplyRequest;
  /**
   * A caller that already rendered the create argv supplies the same one-time
   * identity here. Providers generate it when rendering is deferred.
   */
  readonly bootstrapIdentity?: string;
  readonly launch: (input: {
    readonly heldWorkloadArgv: readonly string[];
    readonly bootstrapIdentity: string;
  }) => Promise<ManagedBootstrapCreateReceipt>;
}

export interface ManagedBootstrapHeldWorkloadHandle {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly bootstrapIdentity: string;
  readonly heldWorkloadArgv: readonly string[];
  readonly intendedWorkloadArgv: readonly string[];
  readonly plan: ManagedBootstrapExpectedPlan;
  readonly createReceipt: ManagedBootstrapCreateReceipt;
}

export interface ManagedBootstrapIncompleteCreateCleanupInput {
  readonly plan: ManagedBootstrapExpectedPlan;
  readonly bootstrapIdentity: string;
  readonly heldWorkloadArgv: readonly string[];
  /** Exact validated receipt for the materialized workload that cleanup may remove. */
  readonly createReceipt: ManagedBootstrapCreateReceipt;
}

export interface ManagedBootstrapDiscoveryInput {
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly bootstrapIdentity: string;
  readonly expectedImage: ManagedBootstrapImageIdentity;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ManagedBootstrapDiscoveredWorkload {
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly runtimeId: string;
  readonly bootstrapIdentity: string;
}

export interface ManagedBootstrapObservedSnapshot {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly runtimeId: string;
  readonly bootstrapIdentity: string;
  readonly image: ManagedBootstrapImageIdentity;
  /** Driver-local immutable content/config identity, distinct from manifestDigest. */
  readonly runtimeImageContentId: string;
  readonly specHash: string;
  readonly specCanonicalJson: string;
  readonly agentIdentity: ManagedBootstrapAgentIdentity;
  readonly supervisorArgv: readonly string[];
  readonly heldWorkloadArgv: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ManagedBootstrapReplacementOptions {
  /**
   * Driver-neutral options contributed by startup compatibility. A provider
   * rejects keys it does not explicitly support.
   */
  readonly values: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

/**
 * Exact stopped replacement authority returned before the owning provider may
 * quiesce, rename, or otherwise mutate the Ready held workload.
 */
export interface ManagedBootstrapPreparedReplacementHandle {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly bootstrapIdentity: string;
  readonly originalRuntimeId: string;
  readonly preparedRuntimeId: string;
  readonly image: ManagedBootstrapImageIdentity;
  readonly runtimeImageContentId: string;
  readonly originalSpecHash: string;
  readonly preparedSpecHash: string;
  readonly preparedSpecCanonicalJson: string;
  readonly expectedActivatedSpecHash: string;
  readonly expectedActivatedSpecCanonicalJson: string;
  readonly profileFingerprint: string;
  /** Provider-opaque, bounded authority needed to clean up or restore exactly this transaction. */
  readonly rollbackAuthority: string;
}

export interface ManagedBootstrapPreparedAuthority {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly phase: "prepared";
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly bootstrapIdentity: string;
  readonly authorityFingerprint: string;
  readonly planFingerprint: string;
  readonly image: ManagedBootstrapImageIdentity;
  readonly runtimeImageContentId: string;
  readonly profileFingerprint: string;
  readonly originalRuntimeId: string;
  readonly preparedRuntimeId: string;
  readonly originalSpecHash: string;
  readonly preparedSpecHash: string;
  readonly expectedActivatedSpecHash: string;
  readonly rollbackTargetRuntimeId: string;
  readonly rollbackTargetSpecHash: string;
  readonly rollbackAuthority: string;
}

export interface ManagedBootstrapDurablePreparationReceipt {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly bootstrapIdentity: string;
  readonly authorityFingerprint: string;
  readonly recordId: string;
  readonly recordedAt: string;
}

export interface ManagedBootstrapAuthorityStore {
  /** Return only after the complete prepared authority is durably recoverable. */
  recordPreparedAuthority(
    authority: ManagedBootstrapPreparedAuthority,
  ): Promise<ManagedBootstrapDurablePreparationReceipt>;
}

export interface ManagedBootstrapReplacementHandle {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly bootstrapIdentity: string;
  readonly originalRuntimeId: string;
  readonly replacementRuntimeId: string;
  readonly image: ManagedBootstrapImageIdentity;
  readonly runtimeImageContentId: string;
  readonly originalSpecHash: string;
  readonly replacementSpecHash: string;
  readonly replacementSpecCanonicalJson: string;
  readonly profileFingerprint: string;
}

export interface ManagedBootstrapCompletionReceipt {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly runtimeId: string;
  readonly image: ManagedBootstrapImageIdentity;
  readonly runtimeImageContentId: string;
  readonly originalSpecHash: string;
  readonly replacementSpecHash: string;
  readonly profileFingerprint: string;
  readonly bootstrapIdentity: string;
  /** True when image-owned bootstrap left a protected shared-state transaction pending. */
  readonly transactionPending: boolean;
  readonly completedAt: string;
}

export interface ManagedBootstrapFinalizationReceipt {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly bootstrapIdentity: string;
  readonly outcome: "committed" | "rolled-back";
  readonly restoredRuntimeId: string | null;
  readonly restoredSpecHash: string | null;
  readonly heldWorkloadRemoved: boolean;
  readonly alreadyRolledBack: boolean;
  readonly finalizedAt: string;
}

/**
 * Driver-neutral evidence that one durable, process-orphaned transaction was
 * reconciled without reconstructing authority from mutable runtime names.
 */
export interface ManagedBootstrapRecoveryReceipt {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly providerId: string;
  /** Provider-owned phase name retained for diagnostics, never central routing. */
  readonly sourcePhase: string;
  readonly sandbox: ManagedBootstrapSandboxIdentity;
  readonly bootstrapIdentity: string;
  readonly outcome: "committed" | "rolled-back";
  readonly finalization: ManagedBootstrapFinalizationReceipt;
}

/** Bounded provider-owned evidence that one durable transaction still needs attention. */
export interface ManagedBootstrapRecoveryFailure {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_SCHEMA_VERSION;
  readonly providerId: string;
  /** Null when the durable record could not prove its provider-owned phase. */
  readonly sourcePhase: string | null;
  /** Null when the durable record could not prove its sandbox identity. */
  readonly sandbox: ManagedBootstrapSandboxIdentity | null;
  readonly bootstrapIdentity: string;
  /** Provider-owned diagnostic code. Central orchestration must not branch on this value. */
  readonly code: string;
  /** Provider-wide when recovery may still own shared provider authority. */
  readonly blockingScope: "provider" | "sandbox";
  readonly retryable: boolean;
  readonly detail: string;
}

/** Lossless provider-neutral recovery output for one bounded enumeration pass. */
export interface ManagedBootstrapRecoveryReport {
  readonly receipts: readonly ManagedBootstrapRecoveryReceipt[];
  readonly failures: readonly ManagedBootstrapRecoveryFailure[];
}

export class ManagedBootstrapDurableCommitCleanupPendingError extends Error {
  readonly bootstrapIdentity: string;
  readonly cleanupRuntimeId: string;

  constructor(input: {
    readonly bootstrapIdentity: string;
    readonly cleanupRuntimeId: string;
    readonly detail: string;
  }) {
    super(
      `Managed bootstrap shared state is durably committed, but finalization cleanup is pending for runtime ${input.cleanupRuntimeId}: ${input.detail}`,
    );
    this.name = "ManagedBootstrapDurableCommitCleanupPendingError";
    this.bootstrapIdentity = input.bootstrapIdentity;
    this.cleanupRuntimeId = input.cleanupRuntimeId;
  }
}

export class ManagedBootstrapCommitStateIndeterminateError extends Error {
  readonly bootstrapIdentity: string;
  readonly runtimeId: string;

  constructor(input: {
    readonly bootstrapIdentity: string;
    readonly runtimeId: string;
    readonly detail: string;
  }) {
    super(
      `Managed bootstrap commit state is indeterminate for runtime ${input.runtimeId}; rollback is unsafe until immutable status is recovered: ${input.detail}`,
    );
    this.name = "ManagedBootstrapCommitStateIndeterminateError";
    this.bootstrapIdentity = input.bootstrapIdentity;
    this.runtimeId = input.runtimeId;
  }
}

/** A provider without exact-ID deletion retains the bounded held workload. */
export class ManagedBootstrapOwnerCleanupRequiredError extends Error {
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly runtimeId: string;

  constructor(input: {
    readonly sandboxName: string;
    readonly sandboxId: string;
    readonly runtimeId: string;
    readonly detail?: string;
  }) {
    super(
      `Managed bootstrap quiesced and retained sandbox '${input.sandboxName}' (ID ${input.sandboxId}, runtime ${input.runtimeId}) because deletion cannot atomically require this durable ID.${input.detail ? ` ${input.detail}` : ""}`,
    );
    this.name = "ManagedBootstrapOwnerCleanupRequiredError";
    this.sandboxName = input.sandboxName;
    this.sandboxId = input.sandboxId;
    this.runtimeId = input.runtimeId;
  }
}

export class ManagedBootstrapRecoveryBlockedError extends Error {
  readonly sandboxName: string;
  readonly failures: readonly ManagedBootstrapRecoveryFailure[];

  constructor(sandboxName: string, failures: readonly ManagedBootstrapRecoveryFailure[]) {
    const first = failures[0];
    super(
      `Managed bootstrap recovery blocks sandbox '${sandboxName}' because ${String(
        failures.length,
      )} durable transaction${failures.length === 1 ? "" : "s"} still need attention.${
        first ? ` First failure ${first.bootstrapIdentity} (${first.code}): ${first.detail}` : ""
      }`,
    );
    this.name = "ManagedBootstrapRecoveryBlockedError";
    this.sandboxName = sandboxName;
    this.failures = Object.freeze([...failures]);
  }
}

export function attachManagedBootstrapRollbackError(failure: Error, rollbackError: unknown): void {
  (
    failure as Error & {
      managedBootstrapRollbackError?: unknown;
    }
  ).managedBootstrapRollbackError = rollbackError;
  const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
  if (!failure.message.includes(detail)) {
    failure.message = `${failure.message}\nManaged bootstrap rollback requires attention: ${detail}`;
  }
}

export interface ManagedBootstrapAdapter {
  /**
   * Enumerate durable unfinished records and reconcile each through the owning
   * provider. Implementations must be restart-safe and idempotent.
   */
  recoverUnfinishedTransactions(): Promise<ManagedBootstrapRecoveryReport>;

  /** Return only after one durable sandbox/driver identity reports Ready. */
  createHeldWorkload(
    input: ManagedBootstrapCreateInput,
  ): Promise<ManagedBootstrapHeldWorkloadHandle>;

  /**
   * Clean up only the exact materialized create identified by its validated
   * Ready receipt after creation fails before returning an identity-bound handle.
   */
  cleanupIncompleteCreate(
    input: ManagedBootstrapIncompleteCreateCleanupInput,
  ): Promise<ManagedBootstrapFinalizationReceipt>;

  /** Resolve exactly one runtime from the complete durable identity. */
  discoverHeldWorkload(
    input: ManagedBootstrapDiscoveryInput,
  ): Promise<ManagedBootstrapDiscoveredWorkload>;

  /** Capture one immutable normalized runtime snapshot before mutation. */
  inspectHeldWorkload(input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly discovered: ManagedBootstrapDiscoveredWorkload;
  }): Promise<ManagedBootstrapObservedSnapshot>;

  /**
   * Create and fully inspect a stopped replacement without changing the held
   * workload. The returned authority must be sufficient for exact cleanup.
   */
  prepareBootstrapReplacement(input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot;
    readonly request: ManagedStartupRootApplyRequest;
    readonly replacementOptions: ManagedBootstrapReplacementOptions;
  }): Promise<ManagedBootstrapPreparedReplacementHandle>;

  /**
   * Perform the destructive cutover only after the coordinator supplies the
   * exact receipt proving that prepared authority was durably recorded.
   */
  activateBootstrapReplacement(input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot;
    readonly prepared: ManagedBootstrapPreparedReplacementHandle;
    readonly durablePreparation: ManagedBootstrapDurablePreparationReceipt;
  }): Promise<ManagedBootstrapReplacementHandle>;

  /** Return an identity-bound completion receipt, never an unqualified boolean. */
  awaitBootstrap(input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot;
    readonly replacement: ManagedBootstrapReplacementHandle;
    readonly timeoutSecs: number;
  }): Promise<ManagedBootstrapCompletionReceipt>;

  /** Commit or roll back using exact handles captured by this transaction. */
  finalizeBootstrap(input: {
    readonly outcome: "commit" | "rollback";
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot | null;
    readonly prepared: ManagedBootstrapPreparedReplacementHandle | null;
    readonly durablePreparation: ManagedBootstrapDurablePreparationReceipt | null;
    readonly replacement: ManagedBootstrapReplacementHandle | null;
    readonly completion: ManagedBootstrapCompletionReceipt | null;
  }): Promise<ManagedBootstrapFinalizationReceipt>;
}

function normalizeRecoveryReceipt(
  candidate: ManagedBootstrapRecoveryReceipt,
): ManagedBootstrapRecoveryReceipt {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
    !["committed", "rolled-back"].includes(String(candidate.outcome))
  ) {
    protocolFail("recovery receipt has an invalid schema or outcome");
  }
  assertOpaqueString(candidate.providerId, "recovery provider ID");
  assertOpaqueString(candidate.sourcePhase, "recovery source phase");
  assertSandboxIdentity(candidate.sandbox);
  if (candidate.sandbox.driverId !== candidate.providerId) {
    protocolFail("recovery provider does not own the recovered sandbox");
  }
  if (!SHA256_RE.test(candidate.bootstrapIdentity)) {
    protocolFail("recovery bootstrap identity must be lowercase SHA-256");
  }
  const finalization = candidate.finalization;
  if (
    typeof finalization !== "object" ||
    finalization === null ||
    Array.isArray(finalization) ||
    finalization.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
    finalization.outcome !== candidate.outcome ||
    finalization.bootstrapIdentity !== candidate.bootstrapIdentity ||
    !isDeepStrictEqual(finalization.sandbox, candidate.sandbox) ||
    typeof finalization.heldWorkloadRemoved !== "boolean" ||
    typeof finalization.alreadyRolledBack !== "boolean"
  ) {
    protocolFail("recovery finalization does not match its durable identity");
  }
  if (
    (finalization.restoredRuntimeId !== null && !SHA256_RE.test(finalization.restoredRuntimeId)) ||
    (finalization.restoredSpecHash !== null && !SHA256_RE.test(finalization.restoredSpecHash)) ||
    (finalization.restoredRuntimeId === null) !== (finalization.restoredSpecHash === null) ||
    (candidate.outcome === "committed" &&
      (finalization.restoredRuntimeId !== null ||
        finalization.heldWorkloadRemoved ||
        finalization.alreadyRolledBack))
  ) {
    protocolFail("recovery finalization state is inconsistent");
  }
  assertTimestamp(finalization.finalizedAt, "recovery finalization timestamp");
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    providerId: candidate.providerId,
    sourcePhase: candidate.sourcePhase,
    sandbox: Object.freeze({ ...candidate.sandbox }),
    bootstrapIdentity: candidate.bootstrapIdentity,
    outcome: candidate.outcome,
    finalization: Object.freeze({
      ...finalization,
      sandbox: Object.freeze({ ...candidate.sandbox }),
    }),
  });
}

function normalizeRecoveryFailure(
  candidate: ManagedBootstrapRecoveryFailure,
): ManagedBootstrapRecoveryFailure {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
    (candidate.blockingScope !== "provider" && candidate.blockingScope !== "sandbox") ||
    typeof candidate.retryable !== "boolean"
  ) {
    protocolFail("recovery failure has an invalid schema");
  }
  assertOpaqueString(candidate.providerId, "recovery failure provider ID", 256);
  if (candidate.sourcePhase !== null) {
    assertOpaqueString(candidate.sourcePhase, "recovery failure source phase", 256);
  }
  if (candidate.sandbox !== null) {
    assertSandboxIdentity(candidate.sandbox);
    if (candidate.sandbox.driverId !== candidate.providerId) {
      protocolFail("recovery failure provider does not own the durable sandbox");
    }
  }
  if (!SHA256_RE.test(candidate.bootstrapIdentity)) {
    protocolFail("recovery failure bootstrap identity must be lowercase SHA-256");
  }
  assertOpaqueString(candidate.code, "recovery failure code", 256);
  assertOpaqueString(candidate.detail, "recovery failure detail", 8 * 1024);
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    providerId: candidate.providerId,
    sourcePhase: candidate.sourcePhase,
    sandbox: candidate.sandbox === null ? null : Object.freeze({ ...candidate.sandbox }),
    bootstrapIdentity: candidate.bootstrapIdentity,
    code: candidate.code,
    blockingScope: candidate.blockingScope,
    retryable: candidate.retryable,
    detail: candidate.detail,
  });
}

/** Recover process-orphaned work without relying on coordinator WeakMap state. */
export async function recoverManagedBootstrapTransactions(
  adapter: ManagedBootstrapAdapter,
): Promise<ManagedBootstrapRecoveryReport> {
  const candidates = await adapter.recoverUnfinishedTransactions();
  if (
    typeof candidates !== "object" ||
    candidates === null ||
    Array.isArray(candidates) ||
    !Array.isArray(candidates.receipts) ||
    !Array.isArray(candidates.failures)
  ) {
    protocolFail("provider recovery must return bounded receipt and failure arrays");
  }
  if (
    candidates.receipts.length + candidates.failures.length >
    MAX_MANAGED_BOOTSTRAP_RECOVERY_RECORDS
  ) {
    protocolFail("provider recovery returned too many records");
  }
  const receipts = candidates.receipts.map(normalizeRecoveryReceipt);
  const failures = candidates.failures.map(normalizeRecoveryFailure);
  const identities = [...receipts, ...failures].map(({ bootstrapIdentity }) => bootstrapIdentity);
  if (new Set(identities).size !== identities.length) {
    protocolFail("provider recovery returned duplicate bootstrap identities");
  }
  const byBootstrapIdentity = (
    left: ManagedBootstrapRecoveryReceipt | ManagedBootstrapRecoveryFailure,
    right: ManagedBootstrapRecoveryReceipt | ManagedBootstrapRecoveryFailure,
  ) => left.bootstrapIdentity.localeCompare(right.bootstrapIdentity);
  return Object.freeze({
    receipts: Object.freeze([...receipts].sort(byBootstrapIdentity)),
    failures: Object.freeze([...failures].sort(byBootstrapIdentity)),
  });
}

/** Block failures that own the requested name or retain provider-wide shared authority. */
export function enforceManagedBootstrapRecoveryForSandbox(
  report: ManagedBootstrapRecoveryReport,
  sandboxName: string,
  warn: (message: string) => void,
): ManagedBootstrapRecoveryReport {
  assertOpaqueString(sandboxName, "recovery target sandbox name");
  const blocking = report.failures.filter(
    (failure) =>
      failure.blockingScope === "provider" ||
      failure.sandbox === null ||
      failure.sandbox.sandboxName === sandboxName,
  );
  for (const failure of report.failures) {
    if (
      failure.blockingScope === "provider" ||
      failure.sandbox === null ||
      failure.sandbox.sandboxName === sandboxName
    )
      continue;
    warn(
      `Managed bootstrap recovery retained unrelated sandbox '${failure.sandbox.sandboxName}' ` +
        `(${failure.bootstrapIdentity}, ${failure.code}).`,
    );
  }
  if (blocking.length > 0) {
    throw new ManagedBootstrapRecoveryBlockedError(
      sandboxName,
      Object.freeze(
        [...blocking].sort((left, right) =>
          left.bootstrapIdentity.localeCompare(right.bootstrapIdentity),
        ),
      ),
    );
  }
  return report;
}

export interface ManagedBootstrapPreparationInput {
  readonly create: ManagedBootstrapCreateInput;
  readonly request: ManagedStartupRootApplyRequest;
  readonly replacementOptions: ManagedBootstrapReplacementOptions;
}

export interface ManagedBootstrapActivationInput {
  readonly transaction: ManagedBootstrapPreparedTransaction;
  readonly authorityStore: ManagedBootstrapAuthorityStore;
  readonly timeoutSecs: number;
}

export interface ManagedBootstrapPreparedTransaction {
  readonly handle: ManagedBootstrapHeldWorkloadHandle;
  readonly snapshot: ManagedBootstrapObservedSnapshot;
  readonly prepared: ManagedBootstrapPreparedReplacementHandle;
}

export interface ManagedBootstrapActivatedTransaction extends ManagedBootstrapPreparedTransaction {
  readonly durablePreparation: ManagedBootstrapDurablePreparationReceipt;
  readonly replacement: ManagedBootstrapReplacementHandle;
  readonly completion: ManagedBootstrapCompletionReceipt;
}

function protocolFail(message: string): never {
  throw new Error(`Managed bootstrap protocol violation: ${message}`);
}

function assertOpaqueString(
  value: unknown,
  label: string,
  maxBytes = 64 * 1024,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    protocolFail(`${label} must be one bounded non-empty string`);
  }
}

function assertExact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    protocolFail(`${label} does not match the transaction authority`);
  }
}

function assertTimestamp(value: unknown, label: string): void {
  assertOpaqueString(value, label);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    protocolFail(`${label} must be a canonical ISO timestamp`);
  }
}

function assertSandboxIdentity(
  sandbox: ManagedBootstrapSandboxIdentity,
  expected?: Pick<ManagedBootstrapSandboxIdentity, "sandboxName" | "driverId">,
): void {
  if (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox)) {
    protocolFail("sandbox identity must be an object");
  }
  assertOpaqueString(sandbox.sandboxName, "sandbox name");
  assertOpaqueString(sandbox.sandboxId, "sandbox ID");
  assertOpaqueString(sandbox.driverId, "driver ID");
  if (
    expected &&
    (sandbox.sandboxName !== expected.sandboxName || sandbox.driverId !== expected.driverId)
  ) {
    protocolFail("sandbox identity does not match the expected plan");
  }
}

function assertImageIdentity(image: ManagedBootstrapImageIdentity): void {
  if (typeof image !== "object" || image === null || Array.isArray(image)) {
    protocolFail("image identity must be an object");
  }
  assertOpaqueString(image.repository, "image repository");
  if (!MANIFEST_DIGEST_RE.test(image.manifestDigest)) {
    protocolFail("image manifest digest must be canonical sha256");
  }
}

function assertAgentIdentity(identity: ManagedBootstrapAgentIdentity): void {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
    protocolFail("agent identity must be an object");
  }
  if (
    !Number.isSafeInteger(identity.uid) ||
    identity.uid < 0 ||
    !Number.isSafeInteger(identity.gid) ||
    identity.gid < 0
  ) {
    protocolFail("agent uid and gid must be non-negative safe integers");
  }
  assertOpaqueString(identity.workdir, "agent workdir");
  if (!identity.workdir.startsWith("/")) {
    protocolFail("agent workdir must be absolute");
  }
}

function assertMetadata(metadata: Readonly<Record<string, string>>): void {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    protocolFail("metadata must be a string record");
  }
  const prototype = Object.getPrototypeOf(metadata);
  if (prototype !== Object.prototype && prototype !== null) {
    protocolFail("metadata must be a plain string record");
  }
  for (const [key, value] of Object.entries(metadata)) {
    assertOpaqueString(key, "metadata key");
    assertOpaqueString(value, `metadata value '${key}'`);
  }
}

function assertArgv(argv: readonly string[], label: string): void {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > 64 * 1024,
    ) ||
    Buffer.byteLength(JSON.stringify(argv), "utf8") > 128 * 1024
  ) {
    protocolFail(`${label} must be one bounded exact argv`);
  }
}

function assertExpectedPlan(
  plan: ManagedBootstrapExpectedPlan,
  request: ManagedStartupRootApplyRequest,
): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    Array.isArray(plan) ||
    plan.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION
  ) {
    protocolFail("expected plan schema version is unsupported");
  }
  assertOpaqueString(plan.sandboxName, "planned sandbox name");
  assertOpaqueString(plan.driverId, "planned driver ID");
  assertImageIdentity(plan.image);
  if (
    typeof plan.profile !== "object" ||
    plan.profile === null ||
    Array.isArray(plan.profile) ||
    plan.profile.agent !== request.agent ||
    plan.profile.fingerprint !== request.profileFingerprint ||
    !SHA256_RE.test(plan.profile.fingerprint)
  ) {
    protocolFail("planned profile does not match the root application request");
  }
  assertAgentIdentity(plan.agentIdentity);
  assertManagedStateRoots(plan.managedStateRoots);
  assertArgv(plan.intendedWorkloadArgv, "intended workload");
  assertArgv(plan.expectedSupervisorArgv, "expected supervisor");
  assertMetadata(plan.metadata);
}

function assertManagedStateRoots(roots: readonly ManagedStartupStateRoot[]): void {
  if (!Array.isArray(roots)) protocolFail("managed state roots must be one exact list");
  const targets = new Set<string>();
  const resources = new Set<string>();
  for (const root of roots) {
    if (
      typeof root !== "object" ||
      root === null ||
      Array.isArray(root) ||
      typeof root.mountTarget !== "string" ||
      !root.mountTarget.startsWith("/") ||
      root.mountTarget === "/" ||
      root.mountTarget.includes("\0") ||
      typeof root.resourceIdentity !== "string" ||
      root.resourceIdentity.length === 0 ||
      root.resourceIdentity.includes("\0") ||
      targets.has(root.mountTarget) ||
      resources.has(root.resourceIdentity) ||
      typeof root.ownershipLabels !== "object" ||
      root.ownershipLabels === null ||
      Array.isArray(root.ownershipLabels) ||
      Object.entries(root.ownershipLabels).some(
        ([name, value]) => name.length === 0 || typeof value !== "string",
      ) ||
      !Number.isSafeInteger(root.uid) ||
      root.uid < 0 ||
      !Number.isSafeInteger(root.gid) ||
      root.gid < 0 ||
      !Number.isSafeInteger(root.mode) ||
      root.mode < 0 ||
      root.mode > 0o7777 ||
      typeof root.readWrite !== "boolean"
    ) {
      protocolFail("managed state-root declaration is invalid");
    }
    targets.add(root.mountTarget);
    resources.add(root.resourceIdentity);
  }
}

function freezeManagedStateRoots(
  roots: readonly ManagedStartupStateRoot[],
): readonly ManagedStartupStateRoot[] {
  assertManagedStateRoots(roots);
  return Object.freeze(
    roots.map((root) =>
      Object.freeze({
        ...root,
        ownershipLabels: freezeMetadata(root.ownershipLabels),
      }),
    ),
  );
}

function freezeArgv(argv: readonly string[], label: string): readonly string[] {
  assertArgv(argv, label);
  return Object.freeze([...argv]);
}

function freezeMetadata(
  metadata: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  assertMetadata(metadata);
  const copy: Record<string, string> = {};
  for (const key of Object.keys(metadata).sort()) {
    Object.defineProperty(copy, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: metadata[key] as string,
    });
  }
  return Object.freeze(copy);
}

function normalizeRootApplyRequest(
  request: ManagedStartupRootApplyRequest,
): ManagedStartupRootApplyRequest {
  return parseManagedStartupRootApplyRequest(serializeManagedStartupRootApplyRequest(request));
}

function normalizeExpectedPlan(
  plan: ManagedBootstrapExpectedPlan,
  request: ManagedStartupRootApplyRequest,
): ManagedBootstrapExpectedPlan {
  assertExpectedPlan(plan, request);
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: plan.sandboxName,
    driverId: plan.driverId,
    image: Object.freeze({
      repository: plan.image.repository,
      manifestDigest: plan.image.manifestDigest,
    }),
    profile: Object.freeze({
      agent: plan.profile.agent,
      fingerprint: plan.profile.fingerprint,
    }),
    agentIdentity: Object.freeze({
      uid: plan.agentIdentity.uid,
      gid: plan.agentIdentity.gid,
      workdir: plan.agentIdentity.workdir,
    }),
    managedStateRoots: freezeManagedStateRoots(plan.managedStateRoots),
    intendedWorkloadArgv: freezeArgv(plan.intendedWorkloadArgv, "intended workload"),
    expectedSupervisorArgv: freezeArgv(plan.expectedSupervisorArgv, "expected supervisor"),
    metadata: freezeMetadata(plan.metadata),
  });
}

function normalizeReplacementOptions(
  options: ManagedBootstrapReplacementOptions,
): ManagedBootstrapReplacementOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    typeof options.values !== "object" ||
    options.values === null ||
    Array.isArray(options.values)
  ) {
    protocolFail("replacement options must be a plain value record");
  }
  const prototype = Object.getPrototypeOf(options.values);
  if (prototype !== Object.prototype && prototype !== null) {
    protocolFail("replacement options must be a plain value record");
  }
  const values: Record<string, string | number | boolean | readonly string[]> = Object.create(
    null,
  ) as Record<string, string | number | boolean | readonly string[]>;
  for (const key of Object.keys(options.values).sort()) {
    assertOpaqueString(key, "replacement option key");
    const value = options.values[key];
    if (Array.isArray(value)) {
      if (value.length > 1024) protocolFail(`replacement option '${key}' has too many values`);
      const entries = value.map((entry) => {
        if (
          typeof entry !== "string" ||
          entry.includes("\0") ||
          Buffer.byteLength(entry, "utf8") > 64 * 1024
        ) {
          protocolFail(`replacement option '${key}' has an invalid list value`);
        }
        return entry;
      });
      values[key] = Object.freeze(entries);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) protocolFail(`replacement option '${key}' must be finite`);
      values[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      values[key] = value;
      continue;
    }
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 64 * 1024
    ) {
      protocolFail(`replacement option '${key}' has an invalid value`);
    }
    values[key] = value;
  }
  return Object.freeze({ values: Object.freeze(values) });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) protocolFail("authority contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") protocolFail("authority contains an unsupported value");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Compare durable provider receipts by canonical value, independent of object key order. */
export function sameManagedBootstrapDurablePreparationReceipt(
  left: ManagedBootstrapDurablePreparationReceipt,
  right: ManagedBootstrapDurablePreparationReceipt,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Compare completion receipts by canonical value, independent of object key order. */
export function sameManagedBootstrapCompletionReceipt(
  left: ManagedBootstrapCompletionReceipt,
  right: ManagedBootstrapCompletionReceipt,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function assertManagedBootstrapIdentity(value: string): void {
  if (!SHA256_RE.test(value)) {
    protocolFail("identity must be 32 random bytes encoded as lowercase hex");
  }
}

export function createManagedBootstrapIdentity(
  randomBytes: (size: number) => Buffer = defaultRandomBytes,
): string {
  const identity = randomBytes(MANAGED_BOOTSTRAP_IDENTITY_BYTES).toString("hex");
  assertManagedBootstrapIdentity(identity);
  return identity;
}

export function assertManagedBootstrapSafeProcessEnvironmentKey(key: string): void {
  if (
    PROCESS_INJECTION_ENV_KEYS.has(key) ||
    PROCESS_INJECTION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  ) {
    throw new Error(`Managed bootstrap refuses process-control environment assignment '${key}'.`);
  }
}

export function renderManagedBootstrapHeldCommand(
  request: ManagedStartupRootApplyRequest,
  bootstrapIdentity: string,
  intendedWorkloadArgv: readonly string[],
): readonly string[] {
  assertManagedBootstrapIdentity(bootstrapIdentity);
  assertArgv(intendedWorkloadArgv, "intended workload");
  if (intendedWorkloadArgv[0] !== "env") {
    protocolFail("intended workload must begin with env");
  }
  let executableIndex = 1;
  while (executableIndex < intendedWorkloadArgv.length) {
    const assignment = intendedWorkloadArgv[executableIndex] as string;
    const separator = assignment.indexOf("=");
    if (separator > 0 && assignment.startsWith("BASH_FUNC_")) {
      assertManagedBootstrapSafeProcessEnvironmentKey(assignment.slice(0, separator));
    }
    if (!ENV_ASSIGNMENT_RE.test(assignment)) break;
    assertManagedBootstrapSafeProcessEnvironmentKey(assignment.slice(0, separator));
    executableIndex += 1;
  }
  if (executableIndex >= intendedWorkloadArgv.length) {
    protocolFail("intended workload executable is missing");
  }
  if (intendedWorkloadArgv[executableIndex] !== MANAGED_STARTUP_EXECUTABLE) {
    protocolFail(`intended workload executable must be ${MANAGED_STARTUP_EXECUTABLE}`);
  }
  return Object.freeze([
    ...intendedWorkloadArgv.slice(0, executableIndex),
    MANAGED_STARTUP_HOLD_EXECUTABLE,
    "--agent",
    request.agent,
    "--profile-fingerprint",
    request.profileFingerprint,
    "--bootstrap-identity",
    bootstrapIdentity,
    "--",
    ...intendedWorkloadArgv.slice(executableIndex + 1),
  ]);
}

function freezeSandboxIdentity(
  sandbox: ManagedBootstrapSandboxIdentity,
  expected?: Pick<ManagedBootstrapSandboxIdentity, "sandboxName" | "driverId">,
): ManagedBootstrapSandboxIdentity {
  assertSandboxIdentity(sandbox, expected);
  return Object.freeze({
    sandboxName: sandbox.sandboxName,
    sandboxId: sandbox.sandboxId,
    driverId: sandbox.driverId,
  });
}

function normalizeCreateReceipt(
  receipt: ManagedBootstrapCreateReceipt,
  plan: ManagedBootstrapExpectedPlan,
): ManagedBootstrapCreateReceipt {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    protocolFail("create receipt must be an object");
  }
  if (receipt.ready !== true) protocolFail("create receipt is not Ready");
  const sandbox = freezeSandboxIdentity(receipt.sandbox, plan);
  assertTimestamp(receipt.readyAt, "create receipt timestamp");
  return Object.freeze({ sandbox, ready: true, readyAt: receipt.readyAt });
}

function normalizeHeldHandle(
  candidate: ManagedBootstrapHeldWorkloadHandle,
  input: ManagedBootstrapCreateInput,
  launchReceipt: ManagedBootstrapCreateReceipt,
): ManagedBootstrapHeldWorkloadHandle {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION
  ) {
    protocolFail("held workload schema version is unsupported");
  }
  assertManagedBootstrapIdentity(candidate.bootstrapIdentity);
  if (candidate.bootstrapIdentity !== input.bootstrapIdentity) {
    protocolFail("held workload changed the caller-supplied bootstrap identity");
  }
  assertExact(candidate.plan, input.plan, "held workload plan");
  assertExact(candidate.sandbox, launchReceipt.sandbox, "held workload sandbox");
  assertExact(candidate.createReceipt, launchReceipt, "held workload create receipt");
  assertExact(
    candidate.intendedWorkloadArgv,
    input.plan.intendedWorkloadArgv,
    "intended workload argv",
  );
  const heldWorkloadArgv = renderManagedBootstrapHeldCommand(
    input.request,
    candidate.bootstrapIdentity,
    input.plan.intendedWorkloadArgv,
  );
  assertExact(candidate.heldWorkloadArgv, heldWorkloadArgv, "held workload argv");
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: launchReceipt.sandbox,
    bootstrapIdentity: candidate.bootstrapIdentity,
    heldWorkloadArgv,
    intendedWorkloadArgv: input.plan.intendedWorkloadArgv,
    plan: input.plan,
    createReceipt: launchReceipt,
  });
}

function normalizeDiscoveredWorkload(
  candidate: ManagedBootstrapDiscoveredWorkload,
  handle: ManagedBootstrapHeldWorkloadHandle,
): ManagedBootstrapDiscoveredWorkload {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    protocolFail("discovered workload must be an object");
  }
  assertExact(candidate.sandbox, handle.sandbox, "discovered sandbox");
  if (candidate.bootstrapIdentity !== handle.bootstrapIdentity) {
    protocolFail("discovered workload bootstrap identity changed");
  }
  assertOpaqueString(candidate.runtimeId, "discovered runtime ID");
  return Object.freeze({
    sandbox: handle.sandbox,
    runtimeId: candidate.runtimeId,
    bootstrapIdentity: handle.bootstrapIdentity,
  });
}

function normalizeObservedSnapshot(
  candidate: ManagedBootstrapObservedSnapshot,
  handle: ManagedBootstrapHeldWorkloadHandle,
  discovered: ManagedBootstrapDiscoveredWorkload,
): ManagedBootstrapObservedSnapshot {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION
  ) {
    protocolFail("observed snapshot schema version is unsupported");
  }
  assertExact(candidate.sandbox, handle.sandbox, "observed sandbox");
  assertExact(candidate.image, handle.plan.image, "observed image");
  assertExact(candidate.agentIdentity, handle.plan.agentIdentity, "observed agent identity");
  assertExact(candidate.supervisorArgv, handle.plan.expectedSupervisorArgv, "supervisor argv");
  assertExact(candidate.heldWorkloadArgv, handle.heldWorkloadArgv, "observed held workload argv");
  assertExact(candidate.metadata, handle.plan.metadata, "observed metadata");
  if (
    candidate.runtimeId !== discovered.runtimeId ||
    candidate.bootstrapIdentity !== handle.bootstrapIdentity
  ) {
    protocolFail("observed runtime identity changed after discovery");
  }
  assertOpaqueString(candidate.runtimeImageContentId, "runtime image content ID");
  if (!SHA256_RE.test(candidate.specHash)) {
    protocolFail("observed spec hash must be canonical sha256");
  }
  assertOpaqueString(candidate.specCanonicalJson, "canonical runtime spec");
  if (
    createHash("sha256").update(candidate.specCanonicalJson, "utf8").digest("hex") !==
    candidate.specHash
  ) {
    protocolFail("observed spec hash does not match its canonical runtime spec");
  }
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    runtimeId: candidate.runtimeId,
    bootstrapIdentity: handle.bootstrapIdentity,
    image: handle.plan.image,
    runtimeImageContentId: candidate.runtimeImageContentId,
    specHash: candidate.specHash,
    specCanonicalJson: candidate.specCanonicalJson,
    agentIdentity: handle.plan.agentIdentity,
    supervisorArgv: handle.plan.expectedSupervisorArgv,
    heldWorkloadArgv: handle.heldWorkloadArgv,
    metadata: handle.plan.metadata,
  });
}

function normalizePreparedReplacement(
  candidate: ManagedBootstrapPreparedReplacementHandle,
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
): ManagedBootstrapPreparedReplacementHandle {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION
  ) {
    protocolFail("prepared bootstrap replacement schema version is unsupported");
  }
  assertExact(candidate.sandbox, handle.sandbox, "prepared bootstrap replacement sandbox");
  assertExact(candidate.image, snapshot.image, "prepared bootstrap replacement image");
  if (
    candidate.bootstrapIdentity !== handle.bootstrapIdentity ||
    candidate.originalRuntimeId !== snapshot.runtimeId ||
    candidate.runtimeImageContentId !== snapshot.runtimeImageContentId ||
    candidate.originalSpecHash !== snapshot.specHash ||
    candidate.profileFingerprint !== handle.plan.profile.fingerprint
  ) {
    protocolFail("prepared bootstrap replacement changed immutable transaction authority");
  }
  assertOpaqueString(candidate.preparedRuntimeId, "prepared runtime ID");
  if (candidate.preparedRuntimeId === candidate.originalRuntimeId) {
    protocolFail("prepared runtime ID must differ from the captured runtime");
  }
  for (const [label, hash] of [
    ["prepared spec hash", candidate.preparedSpecHash],
    ["expected activated spec hash", candidate.expectedActivatedSpecHash],
  ] as const) {
    if (!SHA256_RE.test(hash)) protocolFail(`${label} must be canonical sha256`);
  }
  for (const [label, text, hash] of [
    ["prepared spec", candidate.preparedSpecCanonicalJson, candidate.preparedSpecHash],
    [
      "expected activated spec",
      candidate.expectedActivatedSpecCanonicalJson,
      candidate.expectedActivatedSpecHash,
    ],
  ] as const) {
    assertOpaqueString(text, `${label} canonical JSON`);
    if (createHash("sha256").update(text, "utf8").digest("hex") !== hash) {
      protocolFail(`${label} hash does not match its canonical runtime spec`);
    }
  }
  assertOpaqueString(candidate.rollbackAuthority, "prepared rollback authority");
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    bootstrapIdentity: handle.bootstrapIdentity,
    originalRuntimeId: snapshot.runtimeId,
    preparedRuntimeId: candidate.preparedRuntimeId,
    image: snapshot.image,
    runtimeImageContentId: snapshot.runtimeImageContentId,
    originalSpecHash: snapshot.specHash,
    preparedSpecHash: candidate.preparedSpecHash,
    preparedSpecCanonicalJson: candidate.preparedSpecCanonicalJson,
    expectedActivatedSpecHash: candidate.expectedActivatedSpecHash,
    expectedActivatedSpecCanonicalJson: candidate.expectedActivatedSpecCanonicalJson,
    profileFingerprint: handle.plan.profile.fingerprint,
    rollbackAuthority: candidate.rollbackAuthority,
  });
}

export function createManagedBootstrapPlanFingerprint(plan: ManagedBootstrapExpectedPlan): string {
  return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}

export function createManagedBootstrapPreparedAuthority(
  transaction: ManagedBootstrapPreparedTransaction,
): ManagedBootstrapPreparedAuthority {
  const { handle, snapshot, prepared } = transaction;
  const planFingerprint = createManagedBootstrapPlanFingerprint(handle.plan);
  const bound = Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    phase: "prepared" as const,
    sandbox: handle.sandbox,
    bootstrapIdentity: handle.bootstrapIdentity,
    planFingerprint,
    image: handle.plan.image,
    runtimeImageContentId: snapshot.runtimeImageContentId,
    profileFingerprint: handle.plan.profile.fingerprint,
    originalRuntimeId: snapshot.runtimeId,
    preparedRuntimeId: prepared.preparedRuntimeId,
    originalSpecHash: snapshot.specHash,
    preparedSpecHash: prepared.preparedSpecHash,
    expectedActivatedSpecHash: prepared.expectedActivatedSpecHash,
    rollbackTargetRuntimeId: snapshot.runtimeId,
    rollbackTargetSpecHash: snapshot.specHash,
    rollbackAuthority: prepared.rollbackAuthority,
  });
  const authorityFingerprint = createHash("sha256")
    .update(canonicalJson(bound), "utf8")
    .digest("hex");
  return Object.freeze({ ...bound, authorityFingerprint });
}

function normalizeDurablePreparationReceipt(
  candidate: ManagedBootstrapDurablePreparationReceipt,
  authority: ManagedBootstrapPreparedAuthority,
): ManagedBootstrapDurablePreparationReceipt {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION
  ) {
    protocolFail("durable preparation receipt schema version is unsupported");
  }
  assertExact(candidate.sandbox, authority.sandbox, "durable preparation sandbox");
  if (
    candidate.bootstrapIdentity !== authority.bootstrapIdentity ||
    candidate.authorityFingerprint !== authority.authorityFingerprint
  ) {
    protocolFail("durable preparation receipt changed prepared authority");
  }
  assertOpaqueString(candidate.recordId, "durable preparation record ID");
  assertTimestamp(candidate.recordedAt, "durable preparation timestamp");
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: authority.sandbox,
    bootstrapIdentity: authority.bootstrapIdentity,
    authorityFingerprint: authority.authorityFingerprint,
    recordId: candidate.recordId,
    recordedAt: candidate.recordedAt,
  });
}

function normalizeReplacementHandle(
  candidate: ManagedBootstrapReplacementHandle,
  transaction: ManagedBootstrapPreparedTransaction,
): ManagedBootstrapReplacementHandle {
  const { handle, snapshot, prepared } = transaction;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION
  ) {
    protocolFail("replacement schema version is unsupported");
  }
  assertExact(candidate.sandbox, handle.sandbox, "replacement sandbox");
  assertExact(candidate.image, snapshot.image, "replacement image");
  if (
    candidate.bootstrapIdentity !== handle.bootstrapIdentity ||
    candidate.originalRuntimeId !== snapshot.runtimeId ||
    candidate.replacementRuntimeId !== prepared.preparedRuntimeId ||
    candidate.runtimeImageContentId !== snapshot.runtimeImageContentId ||
    candidate.originalSpecHash !== snapshot.specHash ||
    candidate.replacementSpecHash !== prepared.expectedActivatedSpecHash ||
    candidate.replacementSpecCanonicalJson !== prepared.expectedActivatedSpecCanonicalJson ||
    candidate.profileFingerprint !== handle.plan.profile.fingerprint
  ) {
    protocolFail("replacement receipt changed immutable prepared authority");
  }
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
}

function normalizeCompletionReceipt(
  candidate: ManagedBootstrapCompletionReceipt,
  handle: ManagedBootstrapHeldWorkloadHandle,
  replacement: ManagedBootstrapReplacementHandle,
): ManagedBootstrapCompletionReceipt {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION
  ) {
    protocolFail("completion schema version is unsupported");
  }
  assertExact(candidate.sandbox, handle.sandbox, "completion sandbox");
  assertExact(candidate.image, replacement.image, "completion image");
  if (
    candidate.bootstrapIdentity !== replacement.bootstrapIdentity ||
    candidate.runtimeId !== replacement.replacementRuntimeId ||
    candidate.runtimeImageContentId !== replacement.runtimeImageContentId ||
    candidate.originalSpecHash !== replacement.originalSpecHash ||
    candidate.replacementSpecHash !== replacement.replacementSpecHash ||
    candidate.profileFingerprint !== replacement.profileFingerprint
  ) {
    protocolFail("completion receipt changed immutable transaction authority");
  }
  if (typeof candidate.transactionPending !== "boolean") {
    protocolFail("completion receipt transaction state is invalid");
  }
  assertTimestamp(candidate.completedAt, "completion timestamp");
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
    transactionPending: candidate.transactionPending,
    completedAt: candidate.completedAt,
  });
}

function normalizeFinalizationReceipt(
  candidate: ManagedBootstrapFinalizationReceipt,
  input: {
    readonly outcome: "commit" | "rollback";
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot | null;
  },
): ManagedBootstrapFinalizationReceipt {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
    candidate.outcome !== (input.outcome === "commit" ? "committed" : "rolled-back")
  ) {
    protocolFail("finalization receipt has an invalid schema or outcome");
  }
  assertExact(candidate.sandbox, input.handle.sandbox, "finalization sandbox");
  if (candidate.bootstrapIdentity !== input.handle.bootstrapIdentity) {
    protocolFail("finalization receipt bootstrap identity changed");
  }
  if (
    typeof candidate.heldWorkloadRemoved !== "boolean" ||
    typeof candidate.alreadyRolledBack !== "boolean"
  ) {
    protocolFail("finalization receipt state is invalid");
  }
  if (input.outcome === "commit") {
    if (
      candidate.restoredRuntimeId !== null ||
      candidate.restoredSpecHash !== null ||
      candidate.alreadyRolledBack
    ) {
      protocolFail("commit receipt cannot report rollback state");
    }
  } else if (candidate.heldWorkloadRemoved) {
    if (candidate.restoredRuntimeId !== null || candidate.restoredSpecHash !== null) {
      protocolFail("removed workload receipt cannot also report a restored runtime");
    }
  } else if (
    input.snapshot === null ||
    candidate.restoredRuntimeId !== input.snapshot.runtimeId ||
    candidate.restoredSpecHash !== input.snapshot.specHash
  ) {
    protocolFail("rollback receipt does not restore the exact captured runtime and spec");
  }
  assertTimestamp(candidate.finalizedAt, "finalization timestamp");
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: input.handle.sandbox,
    bootstrapIdentity: input.handle.bootstrapIdentity,
    outcome: candidate.outcome,
    restoredRuntimeId: candidate.restoredRuntimeId,
    restoredSpecHash: candidate.restoredSpecHash,
    heldWorkloadRemoved: candidate.heldWorkloadRemoved,
    alreadyRolledBack: candidate.alreadyRolledBack,
    finalizedAt: candidate.finalizedAt,
  });
}

function normalizeIncompleteCreateCleanupReceipt(
  candidate: ManagedBootstrapFinalizationReceipt,
  createReceipt: ManagedBootstrapCreateReceipt,
  bootstrapIdentity: string,
): ManagedBootstrapFinalizationReceipt {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
    candidate.outcome !== "rolled-back" ||
    candidate.bootstrapIdentity !== bootstrapIdentity ||
    candidate.heldWorkloadRemoved !== true ||
    candidate.restoredRuntimeId !== null ||
    candidate.restoredSpecHash !== null ||
    typeof candidate.alreadyRolledBack !== "boolean"
  ) {
    protocolFail("incomplete-create cleanup receipt does not prove exact absence");
  }
  const sandbox = freezeSandboxIdentity(candidate.sandbox, createReceipt.sandbox);
  assertExact(sandbox, createReceipt.sandbox, "incomplete-create cleanup sandbox");
  assertTimestamp(candidate.finalizedAt, "incomplete-create cleanup timestamp");
  return Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox,
    bootstrapIdentity,
    outcome: "rolled-back",
    restoredRuntimeId: null,
    restoredSpecHash: null,
    heldWorkloadRemoved: true,
    alreadyRolledBack: candidate.alreadyRolledBack,
    finalizedAt: candidate.finalizedAt,
  });
}

function discoveryInput(
  handle: ManagedBootstrapHeldWorkloadHandle,
): ManagedBootstrapDiscoveryInput {
  return Object.freeze({
    sandbox: handle.sandbox,
    bootstrapIdentity: handle.bootstrapIdentity,
    expectedImage: handle.plan.image,
    metadata: handle.plan.metadata,
  });
}

async function rollbackAfterFailure(
  adapter: ManagedBootstrapAdapter,
  error: unknown,
  input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot | null;
    readonly prepared: ManagedBootstrapPreparedReplacementHandle | null;
    readonly durablePreparation: ManagedBootstrapDurablePreparationReceipt | null;
    readonly replacement: ManagedBootstrapReplacementHandle | null;
  },
): Promise<never> {
  const failure = error instanceof Error ? error : new Error(String(error));
  try {
    const rollback = normalizeFinalizationReceipt(
      await adapter.finalizeBootstrap({
        outcome: "rollback",
        ...input,
        completion: null,
      }),
      { outcome: "rollback", handle: input.handle, snapshot: input.snapshot },
    );
    (
      failure as Error & { managedBootstrapRollback?: ManagedBootstrapFinalizationReceipt }
    ).managedBootstrapRollback = rollback;
  } catch (rollbackError) {
    attachManagedBootstrapRollbackError(failure, rollbackError);
  }
  throw failure;
}

type ManagedBootstrapCoordinatorState =
  | "prepared"
  | "activating"
  | "activation-consumed"
  | "activated"
  | "finalizing"
  | "finalized"
  | "rollback-attempted"
  | "finalization-indeterminate";

const TRANSACTION_STATES = new WeakMap<object, ManagedBootstrapCoordinatorState>();

/**
 * Create the held workload and stopped replacement without a destructive
 * cutover. Production wiring is intentionally outside this dormant module.
 */
export async function prepareManagedBootstrapSequence(
  adapter: ManagedBootstrapAdapter,
  input: ManagedBootstrapPreparationInput,
): Promise<ManagedBootstrapPreparedTransaction> {
  const request = normalizeRootApplyRequest(input.request);
  const createRequest = normalizeRootApplyRequest(input.create.request);
  assertExact(createRequest, request, "create root application request");
  const plan = normalizeExpectedPlan(input.create.plan, request);
  const replacementOptions = normalizeReplacementOptions(input.replacementOptions);
  const bootstrapIdentity = input.create.bootstrapIdentity ?? createManagedBootstrapIdentity();
  assertManagedBootstrapIdentity(bootstrapIdentity);
  const heldWorkloadArgv = renderManagedBootstrapHeldCommand(
    request,
    bootstrapIdentity,
    plan.intendedWorkloadArgv,
  );

  let launchCalls = 0;
  let launchProtocolViolation = false;
  let launchReceipt: ManagedBootstrapCreateReceipt | null = null;
  const create: ManagedBootstrapCreateInput = Object.freeze({
    plan,
    request,
    bootstrapIdentity,
    launch: async (candidate: Parameters<ManagedBootstrapCreateInput["launch"]>[0]) => {
      launchCalls += 1;
      if (launchCalls !== 1) {
        launchProtocolViolation = true;
        protocolFail("provider attempted more than one held workload launch");
      }
      if (
        candidate.bootstrapIdentity !== bootstrapIdentity ||
        !isDeepStrictEqual(candidate.heldWorkloadArgv, heldWorkloadArgv)
      ) {
        launchProtocolViolation = true;
        protocolFail("provider changed the identity-bound held workload launch");
      }
      launchReceipt = normalizeCreateReceipt(
        await input.create.launch({ heldWorkloadArgv, bootstrapIdentity }),
        plan,
      );
      return launchReceipt;
    },
  });

  let handle: ManagedBootstrapHeldWorkloadHandle;
  try {
    const candidate = await adapter.createHeldWorkload(create);
    if (launchProtocolViolation || launchCalls !== 1 || !launchReceipt) {
      protocolFail("provider returned a held workload without one exact authorized launch");
    }
    handle = normalizeHeldHandle(candidate, create, launchReceipt);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!launchReceipt) throw failure;
    try {
      const rollback = normalizeIncompleteCreateCleanupReceipt(
        await adapter.cleanupIncompleteCreate({
          plan,
          bootstrapIdentity,
          heldWorkloadArgv,
          createReceipt: launchReceipt,
        }),
        launchReceipt,
        bootstrapIdentity,
      );
      (
        failure as Error & { managedBootstrapRollback?: ManagedBootstrapFinalizationReceipt }
      ).managedBootstrapRollback = rollback;
    } catch (cleanupError) {
      attachManagedBootstrapRollbackError(failure, cleanupError);
    }
    throw failure;
  }

  let snapshot: ManagedBootstrapObservedSnapshot | null = null;
  let prepared: ManagedBootstrapPreparedReplacementHandle | null = null;
  try {
    const discovered = normalizeDiscoveredWorkload(
      await adapter.discoverHeldWorkload(discoveryInput(handle)),
      handle,
    );
    snapshot = normalizeObservedSnapshot(
      await adapter.inspectHeldWorkload({ handle, discovered }),
      handle,
      discovered,
    );
    prepared = normalizePreparedReplacement(
      await adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions,
      }),
      handle,
      snapshot,
    );
    const transaction = Object.freeze({ handle, snapshot, prepared });
    TRANSACTION_STATES.set(transaction, "prepared");
    return transaction;
  } catch (error) {
    return rollbackAfterFailure(adapter, error, {
      handle,
      snapshot,
      prepared,
      durablePreparation: null,
      replacement: null,
    });
  }
}

/** Durably record prepared authority before allowing provider cutover. */
export async function activateManagedBootstrapSequence(
  adapter: ManagedBootstrapAdapter,
  input: ManagedBootstrapActivationInput,
): Promise<ManagedBootstrapActivatedTransaction> {
  if (TRANSACTION_STATES.get(input.transaction) !== "prepared") {
    protocolFail("activation requires the exact prepared transaction returned by this coordinator");
  }
  if (!Number.isFinite(input.timeoutSecs) || input.timeoutSecs <= 0) {
    protocolFail("bootstrap timeout must be positive and finite");
  }
  const { handle, snapshot, prepared } = input.transaction;
  TRANSACTION_STATES.set(input.transaction, "activating");
  let durablePreparation: ManagedBootstrapDurablePreparationReceipt | null = null;
  let replacement: ManagedBootstrapReplacementHandle | null = null;
  try {
    const authority = createManagedBootstrapPreparedAuthority(input.transaction);
    durablePreparation = normalizeDurablePreparationReceipt(
      await input.authorityStore.recordPreparedAuthority(authority),
      authority,
    );
    replacement = normalizeReplacementHandle(
      await adapter.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation,
      }),
      input.transaction,
    );
    const completion = normalizeCompletionReceipt(
      await adapter.awaitBootstrap({
        handle,
        snapshot,
        replacement,
        timeoutSecs: input.timeoutSecs,
      }),
      handle,
      replacement,
    );
    const transaction = Object.freeze({
      ...input.transaction,
      durablePreparation,
      replacement,
      completion,
    });
    TRANSACTION_STATES.set(input.transaction, "activation-consumed");
    TRANSACTION_STATES.set(transaction, "activated");
    return transaction;
  } catch (error) {
    TRANSACTION_STATES.set(input.transaction, "rollback-attempted");
    return rollbackAfterFailure(adapter, error, {
      handle,
      snapshot,
      prepared,
      durablePreparation,
      replacement,
    });
  }
}

/** Validate provider finalization against the exact prepared or activated authority. */
export async function finalizeManagedBootstrapSequence(
  adapter: ManagedBootstrapAdapter,
  input: {
    readonly outcome: "commit" | "rollback";
    readonly transaction:
      | ManagedBootstrapPreparedTransaction
      | ManagedBootstrapActivatedTransaction;
  },
): Promise<ManagedBootstrapFinalizationReceipt> {
  const state = TRANSACTION_STATES.get(input.transaction);
  const activated = state === "activated";
  if (!activated && state !== "prepared") {
    protocolFail("finalization requires an exact coordinator-owned transaction");
  }
  if (input.outcome === "commit" && !activated) {
    protocolFail("commit requires a completed activated transaction");
  }
  const transaction = input.transaction;
  const replacement = activated
    ? (transaction as ManagedBootstrapActivatedTransaction).replacement
    : null;
  const completion = activated
    ? (transaction as ManagedBootstrapActivatedTransaction).completion
    : null;
  TRANSACTION_STATES.set(transaction, "finalizing");
  try {
    const receipt = normalizeFinalizationReceipt(
      await adapter.finalizeBootstrap({
        outcome: input.outcome,
        handle: transaction.handle,
        snapshot: transaction.snapshot,
        prepared: transaction.prepared,
        durablePreparation: activated
          ? (transaction as ManagedBootstrapActivatedTransaction).durablePreparation
          : null,
        replacement,
        completion,
      }),
      { outcome: input.outcome, handle: transaction.handle, snapshot: transaction.snapshot },
    );
    TRANSACTION_STATES.set(transaction, "finalized");
    return receipt;
  } catch (error) {
    TRANSACTION_STATES.set(transaction, "finalization-indeterminate");
    throw error;
  }
}
