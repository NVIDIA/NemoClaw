// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../../state/registry/types";
import type { SandboxRebuildAuthority } from "../../../state/registry/rebuild-authority";
import type { ShippedManagedImageAgent } from "../../managed-image/contract";
import type {
  ManagedWorkloadRebuildHandoff,
  ManagedWorkloadReceipt,
} from "../../workload/rebuild";

export type ManagedWorkloadRebuildPhase =
  | "prepare"
  | "create"
  | "readiness"
  | "restore"
  | "provider-rebind"
  | "registry-commit"
  | "retire-previous"
  | "rollback";

export interface ManagedWorkloadRebuildPlan {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly providerId: string;
  readonly agent: ShippedManagedImageAgent;
  readonly previousAuthority: SandboxRebuildAuthority;
  readonly handoff: ManagedWorkloadRebuildHandoff;
  readonly replacementReceipt: ManagedWorkloadReceipt;
  /**
   * Prevalidated mutable metadata. Authority fields are stripped before this
   * object is retained and cannot override the transaction's exact identities.
   */
  readonly replacementMetadata: Readonly<Partial<SandboxEntry>>;
}

interface ProviderBoundRebuildArtifact {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly transactionId: string;
}

export interface PreparedManagedWorkloadReplacement extends ProviderBoundRebuildArtifact {
  /** Exact provider-owned handle for the workload that remains authoritative. */
  readonly previousRuntimeHandle: string;
  /** Provider-private preparation handle; central orchestration never parses it. */
  readonly preparationHandle: string;
  readonly previousLiveIdentityFingerprint: string;
}

export interface StagedManagedWorkloadReplacement extends ProviderBoundRebuildArtifact {
  readonly previousRuntimeHandle: string;
  /** Exact provider-owned handle used for readiness, rollback, and cutover. */
  readonly stagingHandle: string;
  readonly lifecycleGeneration: string;
  readonly liveIdentityFingerprint: string;
}

export interface ReadyManagedWorkloadReplacement extends StagedManagedWorkloadReplacement {
  readonly readinessReceipt: string;
}

export interface RestoredManagedWorkloadReplacement extends ReadyManagedWorkloadReplacement {
  readonly restoreReceipt: string;
}

export interface ReboundManagedWorkloadReplacement extends RestoredManagedWorkloadReplacement {
  readonly providerRebindReceipt: string;
}

export type ManagedWorkloadReadinessResult =
  | {
      readonly state: "ready";
      readonly replacement: ReadyManagedWorkloadReplacement;
    }
  | {
      readonly state: "not-ready";
      readonly reason: string;
    };

/**
 * One operation-scoped adapter supplied by the selected provider composition.
 * It is identity-bound to RuntimeProviderBundle but is not independently
 * registered or selected. The old workload can be retired only after CAS.
 */
export interface ManagedWorkloadRebuildProviderOperations {
  readonly providerId: string;
  prepare(plan: ManagedWorkloadRebuildPlan): Promise<PreparedManagedWorkloadReplacement>;
  create(
    plan: ManagedWorkloadRebuildPlan,
    prepared: PreparedManagedWorkloadReplacement,
  ): Promise<StagedManagedWorkloadReplacement>;
  waitUntilReady(
    plan: ManagedWorkloadRebuildPlan,
    staged: StagedManagedWorkloadReplacement,
  ): Promise<ManagedWorkloadReadinessResult>;
  restoreState(
    plan: ManagedWorkloadRebuildPlan,
    ready: ReadyManagedWorkloadReplacement,
  ): Promise<RestoredManagedWorkloadReplacement>;
  rebindProviders(
    plan: ManagedWorkloadRebuildPlan,
    restored: RestoredManagedWorkloadReplacement,
  ): Promise<ReboundManagedWorkloadReplacement>;
  /**
   * Must target stagingHandle exactly and be safe to retry. A sandbox name is
   * intentionally insufficient authority for this operation.
   */
  rollback(
    plan: ManagedWorkloadRebuildPlan,
    staged: StagedManagedWorkloadReplacement,
  ): Promise<void>;
  /**
   * Called only after the replacement row wins CAS. Must target the exact
   * previousRuntimeHandle captured during prepare, never sandboxName alone.
   */
  retirePrevious(
    plan: ManagedWorkloadRebuildPlan,
    replacement: ReboundManagedWorkloadReplacement,
  ): Promise<void>;
}

export type ManagedWorkloadRebuildTransactionResult = {
  readonly status: "committed";
  readonly entry: SandboxEntry;
  readonly previousCleanup: "complete" | "pending";
  readonly cleanupError?: unknown;
};

export class ManagedWorkloadRebuildTransactionError extends Error {
  readonly phase: ManagedWorkloadRebuildPhase;
  readonly rollbackError: unknown;

  constructor(
    phase: ManagedWorkloadRebuildPhase,
    message: string,
    options: { readonly cause?: unknown; readonly rollbackError?: unknown } = {},
  ) {
    super(`Managed workload rebuild ${phase} failed: ${message}`, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "ManagedWorkloadRebuildTransactionError";
    this.phase = phase;
    this.rollbackError = options.rollbackError;
  }
}
