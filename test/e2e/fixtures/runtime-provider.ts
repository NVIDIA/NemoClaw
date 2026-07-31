// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExecutionCapability, ExecutionProfile } from "../registry/execution-profile.ts";
import {
  buildExecutionEvidence,
  type ExecutionEvidence,
  type ManagedImageEvidence,
  type NonEmptyProviderReceipts,
} from "../registry/parity-evidence.ts";
import {
  executionPreparationKey,
  type ResolvedRuntimeCase,
  type RuntimeAdapterRequest,
  type RuntimeAdapterRuntime,
} from "../registry/runtime-matrix.ts";
import type { FsmTransition, JsonValue, TerminalOutcome } from "../registry/scenario.ts";

export type RuntimeReadinessEvidence =
  | {
      profileId: string;
      ready: true;
      engineName: string;
      engineVersion: string;
      capabilities: readonly ExecutionCapability[];
    }
  | {
      profileId: string;
      ready: false;
      detail?: string;
    };

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
  providerReceipts: NonEmptyProviderReceipts;
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
  cleanup(
    identity: ExactWorkloadIdentity | Pick<ExactWorkloadIdentity, "logicalId">,
  ): Promise<NonEmptyProviderReceipts>;
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

async function cleanupAfterExecutionFailure(
  provider: RuntimeProviderFixture,
  workloads: readonly (ExactWorkloadIdentity | Pick<ExactWorkloadIdentity, "logicalId">)[],
  executionError: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  for (const workload of workloads) {
    try {
      await provider.lifecycle.cleanup(workload);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [executionError, ...cleanupErrors],
      "Runtime case execution failed and provider cleanup also failed",
      { cause: executionError },
    );
  }
  throw executionError;
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
  if (readiness.ready !== true) {
    throw new Error(
      `Runtime provider for '${runtimeCase.profile.id}' did not report a ready environment`,
    );
  }
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
  if (workload.logicalId !== runtimeCase.identities.sandbox) {
    const mismatch = new Error(
      `workload.logicalId '${workload.logicalId}' does not match case sandbox identity '${runtimeCase.identities.sandbox}'`,
    );
    return cleanupAfterExecutionFailure(
      provider,
      [workload, { logicalId: runtimeCase.identities.sandbox }],
      mismatch,
    );
  }
  let lifecycle: RuntimeLifecycleEvidence;
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
  } catch (executionError) {
    return cleanupAfterExecutionFailure(provider, [workload], executionError);
  }
  const cleanupReceipts = await provider.lifecycle.cleanup(workload);

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
