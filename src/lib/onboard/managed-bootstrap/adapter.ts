// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes as defaultRandomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { MANAGED_STARTUP_HOLD_EXECUTABLE } from "../managed-startup/hold";
import type { ManagedStartupAgent } from "../managed-startup/profile";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";

export const MANAGED_BOOTSTRAP_SCHEMA_VERSION = 1 as const;
export const MANAGED_BOOTSTRAP_IDENTITY_BYTES = 32;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const MANIFEST_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const PROCESS_INJECTION_ENV_KEYS = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "ENV",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
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

/**
 * OpenShell deletion is currently name-only. A provider that cannot enforce an
 * exact immutable owner precondition must retain the bounded held workload.
 */
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
  /** Return only after one durable sandbox/driver identity reports Ready. */
  createHeldWorkload(
    input: ManagedBootstrapCreateInput,
  ): Promise<ManagedBootstrapHeldWorkloadHandle>;

  /**
   * Clean up a materialized create that failed before returning a Ready
   * identity-bound handle.
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
   * Replace the held runtime with the image-owned root trampoline, restore the
   * intended workload command, and retain the captured runtime for rollback.
   */
  replaceForBootstrap(input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot;
    readonly request: ManagedStartupRootApplyRequest;
    readonly replacementOptions: ManagedBootstrapReplacementOptions;
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
    readonly replacement: ManagedBootstrapReplacementHandle | null;
    readonly completion: ManagedBootstrapCompletionReceipt | null;
  }): Promise<ManagedBootstrapFinalizationReceipt>;
}

export interface ManagedBootstrapSequenceInput {
  readonly create: ManagedBootstrapCreateInput;
  readonly request: ManagedStartupRootApplyRequest;
  readonly replacementOptions: ManagedBootstrapReplacementOptions;
  readonly timeoutSecs: number;
}

export interface ManagedBootstrapSequenceResult {
  readonly handle: ManagedBootstrapHeldWorkloadHandle;
  readonly snapshot: ManagedBootstrapObservedSnapshot;
  readonly replacement: ManagedBootstrapReplacementHandle;
  readonly completion: ManagedBootstrapCompletionReceipt;
}

function protocolFail(message: string): never {
  throw new Error(`Managed bootstrap protocol violation: ${message}`);
}

function assertOpaqueString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 64 * 1024
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
  if (new Date(value).toISOString() !== value) {
    protocolFail(`${label} must be a canonical ISO timestamp`);
  }
}

function assertSandboxIdentity(
  sandbox: ManagedBootstrapSandboxIdentity,
  expected?: Pick<ManagedBootstrapSandboxIdentity, "sandboxName" | "driverId">,
): void {
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
  assertOpaqueString(image.repository, "image repository");
  if (!MANIFEST_DIGEST_RE.test(image.manifestDigest)) {
    protocolFail("image manifest digest must be canonical sha256");
  }
}

function assertAgentIdentity(identity: ManagedBootstrapAgentIdentity): void {
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
  if (plan.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION) {
    protocolFail("expected plan schema version is unsupported");
  }
  assertOpaqueString(plan.sandboxName, "planned sandbox name");
  assertOpaqueString(plan.driverId, "planned driver ID");
  assertImageIdentity(plan.image);
  if (
    plan.profile.agent !== request.agent ||
    plan.profile.fingerprint !== request.profileFingerprint ||
    !SHA256_RE.test(plan.profile.fingerprint)
  ) {
    protocolFail("planned profile does not match the root application request");
  }
  assertAgentIdentity(plan.agentIdentity);
  assertArgv(plan.intendedWorkloadArgv, "intended workload");
  assertArgv(plan.expectedSupervisorArgv, "expected supervisor");
  assertMetadata(plan.metadata);
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
  return Object.freeze([
    ...intendedWorkloadArgv.slice(0, executableIndex),
    MANAGED_STARTUP_HOLD_EXECUTABLE,
    "--agent",
    request.agent,
    "--profile-fingerprint",
    request.profileFingerprint,
    "--bootstrap-identity",
    bootstrapIdentity,
  ]);
}

function assertHeldHandle(
  handle: ManagedBootstrapHeldWorkloadHandle,
  input: ManagedBootstrapCreateInput,
): void {
  if (handle.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION) {
    protocolFail("held workload schema version is unsupported");
  }
  assertManagedBootstrapIdentity(handle.bootstrapIdentity);
  if (
    input.bootstrapIdentity !== undefined &&
    handle.bootstrapIdentity !== input.bootstrapIdentity
  ) {
    protocolFail("held workload changed the caller-supplied bootstrap identity");
  }
  assertExact(handle.plan, input.plan, "held workload plan");
  assertSandboxIdentity(handle.sandbox, input.plan);
  assertExact(
    handle.intendedWorkloadArgv,
    input.plan.intendedWorkloadArgv,
    "intended workload argv",
  );
  assertExact(
    handle.heldWorkloadArgv,
    renderManagedBootstrapHeldCommand(
      input.request,
      handle.bootstrapIdentity,
      input.plan.intendedWorkloadArgv,
    ),
    "held workload argv",
  );
  if (handle.createReceipt.ready !== true) {
    protocolFail("create receipt is not Ready");
  }
  assertExact(handle.createReceipt.sandbox, handle.sandbox, "create receipt sandbox");
  assertTimestamp(handle.createReceipt.readyAt, "create receipt timestamp");
}

function assertDiscoveredWorkload(
  discovered: ManagedBootstrapDiscoveredWorkload,
  handle: ManagedBootstrapHeldWorkloadHandle,
): void {
  assertExact(discovered.sandbox, handle.sandbox, "discovered sandbox");
  if (discovered.bootstrapIdentity !== handle.bootstrapIdentity) {
    protocolFail("discovered workload bootstrap identity changed");
  }
  assertOpaqueString(discovered.runtimeId, "discovered runtime ID");
}

function assertObservedSnapshot(
  snapshot: ManagedBootstrapObservedSnapshot,
  handle: ManagedBootstrapHeldWorkloadHandle,
  discovered: ManagedBootstrapDiscoveredWorkload,
): void {
  if (snapshot.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION) {
    protocolFail("observed snapshot schema version is unsupported");
  }
  assertExact(snapshot.sandbox, handle.sandbox, "observed sandbox");
  assertExact(snapshot.image, handle.plan.image, "observed image");
  assertExact(snapshot.agentIdentity, handle.plan.agentIdentity, "observed agent identity");
  assertExact(snapshot.supervisorArgv, handle.plan.expectedSupervisorArgv, "supervisor argv");
  assertExact(snapshot.heldWorkloadArgv, handle.heldWorkloadArgv, "observed held workload argv");
  assertExact(snapshot.metadata, handle.plan.metadata, "observed metadata");
  if (
    snapshot.runtimeId !== discovered.runtimeId ||
    snapshot.bootstrapIdentity !== handle.bootstrapIdentity
  ) {
    protocolFail("observed runtime identity changed after discovery");
  }
  assertOpaqueString(snapshot.runtimeImageContentId, "runtime image content ID");
  if (!SHA256_RE.test(snapshot.specHash)) {
    protocolFail("observed spec hash must be canonical sha256");
  }
  assertOpaqueString(snapshot.specCanonicalJson, "canonical runtime spec");
}

function assertReplacementHandle(
  replacement: ManagedBootstrapReplacementHandle,
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
): void {
  if (replacement.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION) {
    protocolFail("replacement schema version is unsupported");
  }
  assertExact(replacement.sandbox, handle.sandbox, "replacement sandbox");
  assertExact(replacement.image, snapshot.image, "replacement image");
  if (
    replacement.bootstrapIdentity !== handle.bootstrapIdentity ||
    replacement.originalRuntimeId !== snapshot.runtimeId ||
    replacement.runtimeImageContentId !== snapshot.runtimeImageContentId ||
    replacement.originalSpecHash !== snapshot.specHash ||
    replacement.profileFingerprint !== handle.plan.profile.fingerprint
  ) {
    protocolFail("replacement receipt changed immutable transaction authority");
  }
  assertOpaqueString(replacement.replacementRuntimeId, "replacement runtime ID");
  if (replacement.replacementRuntimeId === replacement.originalRuntimeId) {
    protocolFail("replacement runtime ID must differ from the captured runtime");
  }
  if (!SHA256_RE.test(replacement.replacementSpecHash)) {
    protocolFail("replacement spec hash must be canonical sha256");
  }
}

function assertCompletionReceipt(
  completion: ManagedBootstrapCompletionReceipt,
  handle: ManagedBootstrapHeldWorkloadHandle,
  replacement: ManagedBootstrapReplacementHandle,
): void {
  if (completion.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION) {
    protocolFail("completion schema version is unsupported");
  }
  assertExact(completion.sandbox, handle.sandbox, "completion sandbox");
  assertExact(completion.image, replacement.image, "completion image");
  if (
    completion.bootstrapIdentity !== replacement.bootstrapIdentity ||
    completion.runtimeId !== replacement.replacementRuntimeId ||
    completion.runtimeImageContentId !== replacement.runtimeImageContentId ||
    completion.originalSpecHash !== replacement.originalSpecHash ||
    completion.replacementSpecHash !== replacement.replacementSpecHash ||
    completion.profileFingerprint !== replacement.profileFingerprint
  ) {
    protocolFail("completion receipt changed immutable transaction authority");
  }
  if (typeof completion.transactionPending !== "boolean") {
    protocolFail("completion receipt transaction state is invalid");
  }
  assertTimestamp(completion.completedAt, "completion timestamp");
}

function assertRollbackReceipt(
  receipt: ManagedBootstrapFinalizationReceipt,
  handle: ManagedBootstrapHeldWorkloadHandle,
): void {
  if (
    receipt.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
    receipt.outcome !== "rolled-back"
  ) {
    protocolFail("rollback receipt has an invalid schema or outcome");
  }
  assertExact(receipt.sandbox, handle.sandbox, "rollback sandbox");
  if (receipt.bootstrapIdentity !== handle.bootstrapIdentity) {
    protocolFail("rollback receipt bootstrap identity changed");
  }
  if (receipt.restoredRuntimeId !== null) {
    assertOpaqueString(receipt.restoredRuntimeId, "restored runtime ID");
  }
  if (receipt.restoredSpecHash !== null && !SHA256_RE.test(receipt.restoredSpecHash)) {
    protocolFail("restored spec hash must be canonical sha256");
  }
  if (
    typeof receipt.heldWorkloadRemoved !== "boolean" ||
    typeof receipt.alreadyRolledBack !== "boolean"
  ) {
    protocolFail("rollback receipt state is invalid");
  }
  assertTimestamp(receipt.finalizedAt, "rollback timestamp");
}

function discoveryInput(
  handle: ManagedBootstrapHeldWorkloadHandle,
): ManagedBootstrapDiscoveryInput {
  return {
    sandbox: handle.sandbox,
    bootstrapIdentity: handle.bootstrapIdentity,
    expectedImage: handle.plan.image,
    metadata: handle.plan.metadata,
  };
}

/**
 * Own the driver-neutral bootstrap transaction. No discovery or replacement
 * begins until create returns an exact Ready receipt. Production wiring is
 * intentionally outside this module.
 */
export async function runManagedBootstrapSequence(
  adapter: ManagedBootstrapAdapter,
  input: ManagedBootstrapSequenceInput,
): Promise<ManagedBootstrapSequenceResult> {
  assertExpectedPlan(input.create.plan, input.request);
  assertExact(input.create.request, input.request, "create root application request");
  if (!Number.isFinite(input.timeoutSecs) || input.timeoutSecs <= 0) {
    protocolFail("bootstrap timeout must be positive and finite");
  }

  let handle: ManagedBootstrapHeldWorkloadHandle | null = null;
  let snapshot: ManagedBootstrapObservedSnapshot | null = null;
  let replacement: ManagedBootstrapReplacementHandle | null = null;
  try {
    handle = await adapter.createHeldWorkload(input.create);
    assertHeldHandle(handle, input.create);
    const discovered = await adapter.discoverHeldWorkload(discoveryInput(handle));
    assertDiscoveredWorkload(discovered, handle);
    snapshot = await adapter.inspectHeldWorkload({ handle, discovered });
    assertObservedSnapshot(snapshot, handle, discovered);
    replacement = await adapter.replaceForBootstrap({
      handle,
      snapshot,
      request: input.request,
      replacementOptions: input.replacementOptions,
    });
    assertReplacementHandle(replacement, handle, snapshot);
    const completion = await adapter.awaitBootstrap({
      handle,
      snapshot,
      replacement,
      timeoutSecs: input.timeoutSecs,
    });
    assertCompletionReceipt(completion, handle, replacement);
    return Object.freeze({ handle, snapshot, replacement, completion });
  } catch (error) {
    if (handle) {
      const failure = error instanceof Error ? error : new Error(String(error));
      try {
        const rollback = await adapter.finalizeBootstrap({
          outcome: "rollback",
          handle,
          snapshot,
          replacement,
          completion: null,
        });
        assertRollbackReceipt(rollback, handle);
        (
          failure as Error & { managedBootstrapRollback?: ManagedBootstrapFinalizationReceipt }
        ).managedBootstrapRollback = rollback;
      } catch (rollbackError) {
        attachManagedBootstrapRollbackError(failure, rollbackError);
      }
      throw failure;
    }
    throw error;
  }
}
