// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxGpuProofResult } from "../../state/registry";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import type { SandboxGpuConfig } from "../sandbox-gpu-mode";
import type {
  ManagedBootstrapAdapter,
  ManagedBootstrapAgentIdentity,
  ManagedBootstrapAuthorityStore,
  ManagedBootstrapCreateReceipt,
  ManagedBootstrapImageIdentity,
  ManagedBootstrapRecoveryReport,
} from "./adapter";

export interface ManagedBootstrapRuntimeCommandResult {
  readonly status?: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: Error | null;
}

export interface ManagedBootstrapRuntimeDependencies {
  readonly runCaptureOpenshell?: (args: string[], options?: Record<string, unknown>) => string;
  readonly runOpenshell?: (
    args: string[],
    options?: Record<string, unknown>,
  ) => ManagedBootstrapRuntimeCommandResult;
  readonly sleep?: (seconds: number) => void;
}

export type ManagedBootstrapRuntimeRoute = "none" | "native" | "compatibility";

export interface ManagedBootstrapRuntimeLimit {
  readonly name: string;
  readonly soft: number;
  readonly hard: number;
}

export type ManagedBootstrapNativeGpuFallbackRollbackRequest = Readonly<{
  ownerCleanupHandoff: "native-gpu-fallback-after-absent-attachment";
}>;

export type ManagedBootstrapNativeGpuFallbackRollbackOutcome =
  | Readonly<{ kind: "rolled-back" }>
  | Readonly<{
      kind: "openshell-owner-cleanup-required";
      sandboxName: string;
      sandboxId: string;
      runtimeId: string;
    }>;

export type ManagedBootstrapNativeGpuFallbackOwnerCleanupHandoff = Extract<
  ManagedBootstrapNativeGpuFallbackRollbackOutcome,
  { readonly kind: "openshell-owner-cleanup-required" }
>;

export type ManagedBootstrapNativeGpuFallbackOwnerCleanupReceipt = Readonly<{
  kind: "openshell-owner-cleanup-completed";
  sandboxName: string;
  sandboxId: string;
  runtimeId: string;
}>;

export type ManagedBootstrapNativeGpuFallbackOwnerCleanupOutcome =
  | ManagedBootstrapNativeGpuFallbackOwnerCleanupHandoff
  | ManagedBootstrapNativeGpuFallbackOwnerCleanupReceipt;

/** Provider-neutral lifecycle surface consumed by sandbox-create coordinators. */
export interface ManagedBootstrapRuntimePatch {
  maybeApplyDuringCreate(): void | Promise<void>;
  /** Exact runtime ID owned by the transaction, or null until it records a replacement. */
  replacementRuntimeId?(): string | null;
  createFailureMessage(): string | null;
  exitOnPatchError(): void | Promise<void>;
  rollbackManagedStartupAfterCreateFailure(
    request?: ManagedBootstrapNativeGpuFallbackRollbackRequest,
  ):
    | void
    | ManagedBootstrapNativeGpuFallbackRollbackOutcome
    | Promise<void | ManagedBootstrapNativeGpuFallbackRollbackOutcome>;
  ensureApplied(): void | Promise<void>;
  waitForSupervisorReconnectIfNeeded(): void | Promise<void>;
  commitAfterReady(): void | Promise<void>;
  selectedMode(): {
    readonly kind: string;
    readonly label: string;
    readonly device: string;
    readonly args: readonly string[];
  } | null;
  printReadinessFailureIfEnabled(): void;
  verifyGpuOrExit(
    verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult,
  ): Promise<SandboxGpuProofResult>;
}

export interface ManagedBootstrapRuntimeCreateLifecycleInput {
  readonly providerId: string;
  readonly stateRoot: string;
  readonly bootstrapIdentity: string;
  readonly request: ManagedStartupRootApplyRequest;
  readonly image: ManagedBootstrapImageIdentity;
  readonly agentIdentity: ManagedBootstrapAgentIdentity;
  readonly intendedWorkloadArgv: readonly string[];
  readonly expectedSupervisorArgv: readonly string[];
  readonly launchArgv: readonly string[];
  readonly heldWorkloadArgv: readonly string[];
  readonly authorityStore: ManagedBootstrapAuthorityStore;
  readonly adapterOverride?: ManagedBootstrapAdapter;
  readonly route: ManagedBootstrapRuntimeRoute;
  readonly persistStartupCommand: boolean;
  readonly sandboxName: string;
  readonly sandboxGpuConfig: SandboxGpuConfig;
  readonly requiredLimits: readonly ManagedBootstrapRuntimeLimit[];
  readonly timeoutSecs: number;
  readonly onPatchFailure?: (error: unknown) => never;
  readonly network: {
    readonly inferenceProvider: string;
    readonly gatewayUsesContainerBridge: boolean;
    readonly gatewayPort: number;
  };
  readonly dependencies: ManagedBootstrapRuntimeDependencies;
}

export interface ManagedBootstrapRuntimeCreateLaunchResult<T> {
  readonly value: T;
  readonly receipt: ManagedBootstrapCreateReceipt;
}

export type ManagedBootstrapTerminalOutcome = "commit" | "rollback";

export interface ManagedBootstrapTerminalFinalizer {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Claim one terminal outcome before driver finalization starts. Duplicate calls
 * for that outcome share the in-flight promise; the opposite outcome fails
 * closed even when finalization loses acknowledgement.
 */
export function createManagedBootstrapTerminalFinalizer(
  finalize: (outcome: ManagedBootstrapTerminalOutcome) => Promise<void>,
): ManagedBootstrapTerminalFinalizer {
  let claimedOutcome: ManagedBootstrapTerminalOutcome | null = null;
  let pending: Promise<void> | null = null;
  const run = (outcome: ManagedBootstrapTerminalOutcome): Promise<void> => {
    if (claimedOutcome === outcome && pending !== null) return pending;
    if (claimedOutcome !== null) {
      return Promise.reject(
        new Error(
          `Managed bootstrap ${outcome} is no longer legal after ${claimedOutcome} finalization began.`,
        ),
      );
    }
    claimedOutcome = outcome;
    pending = Promise.resolve().then(() => finalize(outcome));
    return pending;
  };
  return Object.freeze({
    commit: () => run("commit"),
    rollback: () => run("rollback"),
  });
}

export interface ManagedBootstrapRuntimeCreateLifecycle {
  readonly launchArgv: readonly string[];
  readonly patch: ManagedBootstrapRuntimePatch;
  /**
   * Inspect the exact activated native runtime when provider authority is available.
   * `undefined` means activation has not selected a runtime yet; `null` fails closed.
   */
  inspectNativeRuntime?(): ManagedBootstrapRuntimeSnapshot | null | undefined;
  /** Consume an exact provider-owned handoff before a single compatibility retry. */
  completeNativeGpuFallbackOwnerCleanup?(
    handoff: ManagedBootstrapNativeGpuFallbackOwnerCleanupHandoff,
  ): Promise<ManagedBootstrapNativeGpuFallbackOwnerCleanupOutcome>;
  recoverUnfinished(): Promise<ManagedBootstrapRecoveryReport>;
  prepareNetwork(): Promise<void>;
  runCreate<T>(
    launch: (input: {
      readonly heldWorkloadArgv: readonly string[];
      readonly bootstrapIdentity: string;
    }) => Promise<ManagedBootstrapRuntimeCreateLaunchResult<T>>,
  ): Promise<T>;
}

export interface ManagedBootstrapRuntimeSnapshot {
  readonly imageId: string | null;
  readonly bookkeepingImageRef: string | null;
  readonly stateError: string;
  readonly nativeGpuAttachmentState: "present" | "absent" | "unknown";
}

export interface ManagedBootstrapRuntimeCompatibilityLaunchInput {
  readonly createArgs: readonly string[];
  readonly currentRegistryImageRef: string | null;
  readonly prebuildImageId: string | null;
  readonly allowUnbuiltSource: boolean;
  readonly compatibilityPolicyPath: string;
  readonly startupCommand: readonly string[];
  readonly runtimeSnapshot: ManagedBootstrapRuntimeSnapshot | null;
}

export interface ManagedBootstrapRuntimeCompatibilityLaunch {
  readonly createArgv: readonly string[];
  readonly registryImageRef: string | null;
}

/** Provider-owned native-to-compatibility evidence and launch preparation. */
export interface ManagedBootstrapRuntimeOnboardRouting {
  readonly nativeFallbackHasCleanBaseline: boolean;
  inspectNativeRuntime(): ManagedBootstrapRuntimeSnapshot | null;
  isNativeCreateRoutingFailure(output: string, sawProgress: boolean): boolean;
  isTrustedNativeRuntimeError(error: string): boolean;
  isNativeReadinessRoutingFailure(input: {
    readonly failurePhase: string | null;
    readonly runtimeError: string;
  }): boolean;
  prepareCompatibilityLaunch(
    input: ManagedBootstrapRuntimeCompatibilityLaunchInput,
  ): ManagedBootstrapRuntimeCompatibilityLaunch;
}

export interface ManagedBootstrapRuntimeOnboardRoutingInput {
  readonly sandboxName: string;
  readonly openshellArgv: (args: string[]) => string[];
  readonly nativeFallbackEnabled: boolean;
}
