// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes as defaultRandomBytes } from "node:crypto";

import { MANAGED_STARTUP_HOLD_EXECUTABLE } from "../managed-startup/hold";
import type { ManagedStartupAgent } from "../managed-startup/profile";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";

export const MANAGED_BOOTSTRAP_SCHEMA_VERSION = 1 as const;
export const MANAGED_BOOTSTRAP_IDENTITY_BYTES = 32;

const SHA256_RE = /^[a-f0-9]{64}$/u;
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
   * A caller that has already rendered the OpenShell create argv supplies the
   * same one-time identity here. Adapters generate it when launch rendering is
   * deferred until createHeldWorkload.
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
   * Driver-neutral, normalized options contributed by GPU/startup
   * compatibility. The adapter rejects keys it does not explicitly support.
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

export interface ManagedBootstrapAdapter {
  /**
   * Launch OpenShell with a bounded hold and return only after OpenShell
   * reports Ready for one durable sandbox/driver identity.
   */
  createHeldWorkload(
    input: ManagedBootstrapCreateInput,
  ): Promise<ManagedBootstrapHeldWorkloadHandle>;

  /**
   * Resolve exactly one runtime from the durable sandbox, driver, bootstrap,
   * image, metadata, and expected-spec identities. Zero and multiple matches
   * are both terminal failures.
   */
  discoverHeldWorkload(
    input: ManagedBootstrapDiscoveryInput,
  ): Promise<ManagedBootstrapDiscoveredWorkload>;

  /** Capture one immutable, normalized runtime snapshot before mutation. */
  inspectHeldWorkload(input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly discovered: ManagedBootstrapDiscoveredWorkload;
  }): Promise<ManagedBootstrapObservedSnapshot>;

  /**
   * Replace the held runtime with an image-owned root trampoline, restore the
   * intended workload command, and preserve the captured runtime for rollback.
   */
  replaceForBootstrap(input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot;
    readonly request: ManagedStartupRootApplyRequest;
    readonly replacementOptions: ManagedBootstrapReplacementOptions;
  }): Promise<ManagedBootstrapReplacementHandle>;

  /** Return an identity-bound receipt, never an unqualified boolean. */
  awaitBootstrap(input: {
    readonly handle: ManagedBootstrapHeldWorkloadHandle;
    readonly snapshot: ManagedBootstrapObservedSnapshot;
    readonly replacement: ManagedBootstrapReplacementHandle;
    readonly timeoutSecs: number;
  }): Promise<ManagedBootstrapCompletionReceipt>;

  /**
   * Driver-neutral cutover decision. Commit is legal only after the caller's
   * authoritative gates pass; rollback also owns post-create held-workload
   * cleanup when no stable snapshot was captured.
   */
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

export function assertManagedBootstrapIdentity(value: string): void {
  if (!SHA256_RE.test(value)) {
    throw new Error("Managed bootstrap identity must be 32 random bytes encoded as lowercase hex.");
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

function assertArgv(argv: readonly string[], label: string): void {
  if (
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
    throw new Error(`Managed bootstrap ${label} must be one bounded exact argv.`);
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
    throw new Error("Managed bootstrap intended workload must begin with env.");
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
    throw new Error("Managed bootstrap intended workload executable is missing.");
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
 * Own the complete managed-bootstrap transaction. No runtime discovery or
 * replacement begins until createHeldWorkload has returned a Ready receipt.
 */
export async function runManagedBootstrapSequence(
  adapter: ManagedBootstrapAdapter,
  input: ManagedBootstrapSequenceInput,
): Promise<ManagedBootstrapSequenceResult> {
  let handle: ManagedBootstrapHeldWorkloadHandle | null = null;
  let snapshot: ManagedBootstrapObservedSnapshot | null = null;
  let replacement: ManagedBootstrapReplacementHandle | null = null;
  try {
    handle = await adapter.createHeldWorkload(input.create);
    assertManagedBootstrapIdentity(handle.bootstrapIdentity);
    const discovered = await adapter.discoverHeldWorkload(discoveryInput(handle));
    snapshot = await adapter.inspectHeldWorkload({ handle, discovered });
    replacement = await adapter.replaceForBootstrap({
      handle,
      snapshot,
      request: input.request,
      replacementOptions: input.replacementOptions,
    });
    const completion = await adapter.awaitBootstrap({
      handle,
      snapshot,
      replacement,
      timeoutSecs: input.timeoutSecs,
    });
    return { handle, snapshot, replacement, completion };
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
        (
          failure as Error & { managedBootstrapRollback?: ManagedBootstrapFinalizationReceipt }
        ).managedBootstrapRollback = rollback;
      } catch (rollbackError) {
        (
          failure as Error & { managedBootstrapRollbackError?: unknown }
        ).managedBootstrapRollbackError = rollbackError;
      }
      throw failure;
    }
    throw error;
  }
}
