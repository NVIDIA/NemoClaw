// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExecutionCapability, ExecutionProfile } from "../registry/execution-profile.ts";
import {
  buildExecutionEvidence,
  type ExecutionEvidence,
  type ManagedImageEvidence,
  type ProviderReceipt,
} from "../registry/parity-evidence.ts";
import {
  executionPreparationKey,
  type ResolvedRuntimeCase,
  type RuntimeAdapterRequest,
  type RuntimeAdapterRuntime,
} from "../registry/runtime-matrix.ts";
import type { FsmTransition, JsonValue, TerminalOutcome } from "../registry/scenario.ts";

export interface RuntimeReadinessEvidence {
  profileId: string;
  ready: true;
  engineName: string;
  engineVersion: string;
  capabilities: readonly ExecutionCapability[];
}

export interface ExactWorkloadIdentity {
  logicalId: string;
  providerResourceId: string;
  managedImages: readonly ManagedImageEvidence[];
}

export interface RuntimeLifecycleRequest {
  caseId: string;
  workload: ExactWorkloadIdentity;
}

export interface RuntimeLifecycleEvidence {
  desiredState: JsonValue;
  fsmTrace: readonly FsmTransition[];
  terminalOutcome: TerminalOutcome;
  userVisibleState: JsonValue;
  providerReceipts: readonly ProviderReceipt[];
}

/**
 * Provider commands stop at this seam. Scenario, matrix, and parity code use
 * only normalized evidence and exact workload identities.
 */
export interface RuntimeProviderEnvironment {
  prepare(): Promise<RuntimeReadinessEvidence>;
}

export interface RuntimeProviderLifecycle {
  executeAdapter(adapterId: string, request: RuntimeAdapterRequest): Promise<void>;
  cleanup(identity: ExactWorkloadIdentity): Promise<readonly ProviderReceipt[]>;
}

export interface RuntimeProviderState {
  inspectWorkload(request: { logicalId: string }): Promise<ExactWorkloadIdentity>;
  observe(request: RuntimeLifecycleRequest): Promise<RuntimeLifecycleEvidence>;
}

export interface RuntimeProviderFixture extends RuntimeAdapterRuntime {
  readonly profile: ExecutionProfile;
  readonly environment: RuntimeProviderEnvironment;
  readonly lifecycle: RuntimeProviderLifecycle;
  readonly state: RuntimeProviderState;
}

export interface RuntimeExecutionRequest {
  resolved: ResolvedRuntimeCase;
  provider: RuntimeProviderFixture;
  source: {
    headSha: string;
    baseSha: string;
  };
}

/**
 * The only executable cross-runtime path in this foundation. It does not use
 * the legacy Docker-shaped environment/lifecycle/state fixtures and is not
 * selected by any canonical target or workflow.
 */
export async function executeRuntimeCaseThroughProvider(
  request: RuntimeExecutionRequest,
): Promise<ExecutionEvidence> {
  const { case: runtimeCase } = request.resolved;
  const provider = request.provider;
  if (
    provider.profile.id !== runtimeCase.profile.id ||
    executionPreparationKey(provider.profile) !== runtimeCase.preparationKey
  ) {
    throw new Error(
      `Runtime provider profile '${provider.profile.id}' does not match case '${runtimeCase.id}'`,
    );
  }
  const readiness = await provider.environment.prepare();
  if (readiness.profileId !== runtimeCase.profile.id) {
    throw new Error(
      `Runtime readiness profile '${readiness.profileId}' does not match '${runtimeCase.profile.id}'`,
    );
  }
  const missingCapabilities = runtimeCase.profile.capabilities.filter(
    (capability) => !readiness.capabilities.includes(capability),
  );
  if (missingCapabilities.length > 0) {
    throw new Error(
      `Runtime readiness for '${runtimeCase.profile.id}' is missing capabilities: ${missingCapabilities.join(", ")}`,
    );
  }

  const workload = await provider.state.inspectWorkload({
    logicalId: runtimeCase.identities.sandbox,
  });
  let lifecycle: RuntimeLifecycleEvidence;
  let cleanupReceipts: readonly ProviderReceipt[] = [];
  try {
    for (const binding of runtimeCase.obligationBindings) {
      await binding.adapter.execute(provider, {
        caseId: runtimeCase.id,
        obligationId: binding.obligationId,
        workloadId: workload.logicalId,
      });
    }
    lifecycle = await provider.state.observe({
      caseId: runtimeCase.id,
      workload,
    });
  } finally {
    cleanupReceipts = await provider.lifecycle.cleanup(workload);
  }

  return buildExecutionEvidence({
    resolved: request.resolved,
    source: request.source,
    engine: {
      name: readiness.engineName,
      version: readiness.engineVersion,
    },
    workload,
    observed: {
      desiredState: lifecycle.desiredState,
      fsmTrace: lifecycle.fsmTrace,
      terminalOutcome: lifecycle.terminalOutcome,
      userVisibleState: lifecycle.userVisibleState,
    },
    providerReceipts: [...lifecycle.providerReceipts, ...cleanupReceipts],
  });
}
