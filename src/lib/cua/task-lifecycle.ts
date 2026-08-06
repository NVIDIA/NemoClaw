// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import {
  type CuaTaskAdapter,
  CuaTaskAdapterInvocationError,
  type CuaTaskAdapterResult,
  type CuaTaskMode,
  type CuaTaskOperation,
} from "../adapters/cua-task";
import { withLock } from "../state/registry/lock";
import { load, save } from "../state/registry/persistence";
import type { SandboxRegistry } from "../state/registry/types";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaAppliedPolicyIdentity,
  type CuaCapability,
  type CuaFailure,
  type CuaFailureFamily,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
  type CuaTaskResult,
  getCuaRuntimeReadinessDigest,
} from "./contract";
import { isCuaFrameworkEnabled } from "./feature";
import {
  assertCuaLifecycleReadinessUnchanged,
  assertCuaLiveAppliedPolicyUnchanged,
  type CuaLifecycleReadinessDeps,
  requireCuaLifecycleReadiness,
  requireCuaLiveAppliedPolicy,
} from "./lifecycle-readiness";
import { executeCuaLifecycleRegistryTransaction } from "./lifecycle-registry-transaction";
import {
  beginCuaSideEffectReconciliation,
  cuaReconciliationAllowsOperation,
  cuaTaskCancelCompletesReconciliation,
  isCuaAuthorityReconciliation,
  isCuaReconciliationSideEffectOperation,
  quarantineCuaAuthority,
  recordCuaReconciliationObservation,
} from "./reconciliation";
import { parseCuaLifecycleRecord } from "./schema";
import { cuaSecurityAttestationMatches } from "./security-lifecycle";

export interface CuaTaskLifecycleInput {
  operation: CuaTaskOperation;
  sandboxName: string;
  taskId: string;
  adapter?: CuaTaskAdapter;
  mode?: CuaTaskMode;
  input?: string;
}

export interface CuaTaskLifecycleResult {
  record: CuaTargetAttachment | CuaTaskResult | CuaFailure;
  exitCode: number;
}

export interface CuaTaskLifecycleDeps extends CuaLifecycleReadinessDeps {
  load: () => SandboxRegistry;
  save: (registry: SandboxRegistry) => void;
  withLock: <T>(fn: () => T) => T;
  isFrameworkEnabled?: () => boolean;
  requireRuntimeReadiness?: typeof requireCuaLifecycleReadiness;
  checkpoint?: () => boolean;
}

const defaultDeps: CuaTaskLifecycleDeps = { load, save, withLock };
const MAX_TASK_INPUT_BYTES = 64 * 1024;
const MAX_COMPLETED_RESULTS = 16;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_TASK_ID =
  /(?:auth|bearer|credential|password|secret|token)|(?:^|[/._-])(?:ghp_|sk-)/i;

export const CUA_TASK_EXIT_CODES = {
  success: 0,
  validation: 2,
  conflict: 3,
  unavailable: 4,
  execution: 5,
} as const;

function failure(
  operation: CuaTaskOperation,
  family: CuaFailureFamily,
  retryable: boolean,
  component?: CuaCapability | "runtime" | "inference" | "policy" | "target",
): CuaFailure {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family,
    retryable,
    ...(component ? { component } : {}),
  };
}

function exitCodeFor(family: CuaFailureFamily): number {
  if (family === "validation_failed") return CUA_TASK_EXIT_CODES.validation;
  if (family === "task_conflict") return CUA_TASK_EXIT_CODES.conflict;
  if (family === "lifecycle_unavailable" || family === "runtime_unavailable") {
    return CUA_TASK_EXIT_CODES.unavailable;
  }
  return CUA_TASK_EXIT_CODES.execution;
}

function result(record: CuaTargetAttachment | CuaTaskResult | CuaFailure): CuaTaskLifecycleResult {
  return {
    record,
    exitCode: record.kind === "failure" ? exitCodeFor(record.family) : CUA_TASK_EXIT_CODES.success,
  };
}

function failed(
  operation: CuaTaskOperation,
  family: CuaFailureFamily,
  retryable: boolean,
  component?: CuaCapability | "runtime" | "inference" | "policy" | "target",
): CuaTaskLifecycleResult {
  return result(failure(operation, family, retryable, component));
}

function validPrivateInput(input: CuaTaskLifecycleInput): boolean {
  const requiresInput = input.operation === "task.start";
  if (requiresInput !== (input.input !== undefined)) return false;
  if (input.input === undefined) return true;
  return input.input.length > 0 && Buffer.byteLength(input.input, "utf8") <= MAX_TASK_INPUT_BYTES;
}

function validTaskId(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId) && !SENSITIVE_TASK_ID.test(taskId);
}

function matchingStoredResult(
  registry: SandboxRegistry,
  sandboxName: string,
  taskId: string,
): CuaTaskResult | undefined {
  return [...(registry.sandboxes[sandboxName]?.cuaTaskResults ?? [])]
    .reverse()
    .find((entry) => entry.taskId === taskId);
}

function capabilityIdentities(
  target: NonNullable<CuaTargetAttachment["target"]>,
): Array<{ id: CuaCapability; protocolVersion: string }> {
  return target.capabilities
    .filter(({ id }) => id === "browser")
    .map(({ id, protocolVersion }) => ({ id, protocolVersion }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function taskResultMatches(
  taskResult: CuaTaskResult,
  taskId: string,
  runtime: CuaRuntimeReadiness,
  target: NonNullable<CuaTargetAttachment["target"]>,
  appliedPolicy: CuaAppliedPolicyIdentity,
): boolean {
  const runtimeReadinessDigest = getCuaRuntimeReadinessDigest(runtime);
  return (
    taskResult.taskId === taskId &&
    taskResult.targetIdentityDigest === target.identityDigest &&
    taskResult.runtimeReadinessDigest === runtimeReadinessDigest &&
    isDeepStrictEqual(taskResult.components.openshell, runtime.components.openshell) &&
    isDeepStrictEqual(taskResult.components.runtime, runtime.components.runtime) &&
    isDeepStrictEqual(taskResult.components.sandboxImage, runtime.components.sandboxImage) &&
    isDeepStrictEqual(taskResult.components.policy, runtime.components.policy) &&
    isDeepStrictEqual(taskResult.components.taskProtocol, runtime.components.taskProtocol) &&
    isDeepStrictEqual(taskResult.components.targetImage, target.image) &&
    isDeepStrictEqual(taskResult.components.serviceBundle, target.serviceBundle) &&
    isDeepStrictEqual(taskResult.inference, runtime.inference) &&
    isDeepStrictEqual(taskResult.appliedPolicy, appliedPolicy) &&
    isDeepStrictEqual(
      [...taskResult.capabilities].sort((left, right) => left.id.localeCompare(right.id)),
      capabilityIdentities(target),
    )
  );
}

function activeAttachmentMatches(
  observed: CuaTargetAttachment,
  current: CuaTargetAttachment,
  taskId: string,
  appliedPolicy: CuaAppliedPolicyIdentity,
  reconciliationStatus = false,
): boolean {
  return (
    observed.status === "attached" &&
    observed.target !== null &&
    current.target !== null &&
    observed.runtimeReadinessDigest === current.runtimeReadinessDigest &&
    (reconciliationStatus ||
      (observed.activeTask?.taskId === taskId &&
        isDeepStrictEqual(observed.activeTask.appliedPolicy, appliedPolicy))) &&
    isDeepStrictEqual(observed.target, current.target)
  );
}

function clearPolicyBoundState(sandbox: SandboxRegistry["sandboxes"][string]): void {
  delete sandbox.cuaSecurityAttestation;
  delete sandbox.cuaTaskResults;
}

function invokeAdapter(
  input: CuaTaskLifecycleInput,
  runtime: CuaRuntimeReadiness,
  target: CuaTargetAttachment,
  appliedPolicy: CuaAppliedPolicyIdentity,
): CuaTaskAdapterResult {
  if (!input.adapter) return failure(input.operation, "lifecycle_unavailable", false, "runtime");
  try {
    const record = parseCuaLifecycleRecord(
      input.adapter.execute({
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "task-adapter-request",
        operation: input.operation,
        sandboxName: input.sandboxName,
        taskId: input.taskId,
        mode: input.mode ?? null,
        input: input.input ?? null,
        appliedPolicy,
        runtime,
        target,
      }),
    );
    if (
      record.kind !== "target-attachment" &&
      record.kind !== "task-result" &&
      record.kind !== "failure"
    ) {
      return failure(input.operation, "validation_failed", false, "runtime");
    }
    return record;
  } catch (error) {
    if (error instanceof CuaTaskAdapterInvocationError) {
      return failure(input.operation, error.family, error.retryable, "runtime");
    }
    return failure(input.operation, "runtime_unavailable", false, "runtime");
  }
}

function operationAccepts(
  operation: CuaTaskOperation,
  adapterResult: Exclude<CuaTaskAdapterResult, CuaFailure>,
): boolean {
  if (operation === "task.result" || operation === "task.cancel") {
    return adapterResult.kind === "task-result";
  }
  if (operation === "task.status") {
    return adapterResult.kind === "target-attachment" || adapterResult.kind === "task-result";
  }
  return adapterResult.kind === "target-attachment";
}

function persistFailureState(
  registry: SandboxRegistry,
  sandboxName: string,
  taskId: string,
  failureRecord: CuaFailure,
): boolean {
  const target = registry.sandboxes[sandboxName]?.cuaTarget;
  if (!target || target.activeTask?.taskId !== taskId) return false;
  const targetStatus =
    failureRecord.family === "target_replaced"
      ? "replaced"
      : failureRecord.family === "target_incompatible"
        ? "incompatible"
        : failureRecord.family === "target_unreachable" ||
            failureRecord.family === "capability_unhealthy"
          ? "unreachable"
          : null;
  if (!targetStatus) return false;
  target.status = targetStatus;
  return true;
}

function persistResult(
  registry: SandboxRegistry,
  sandboxName: string,
  taskResult: CuaTaskResult,
): void {
  const sandbox = registry.sandboxes[sandboxName];
  if (!sandbox?.cuaTarget) return;
  sandbox.cuaTarget.activeTask = null;
  const withoutCurrent = (sandbox.cuaTaskResults ?? []).filter(
    (entry) => entry.taskId !== taskResult.taskId,
  );
  sandbox.cuaTaskResults = [...withoutCurrent, taskResult].slice(-MAX_COMPLETED_RESULTS);
}

function executeLocked(
  input: CuaTaskLifecycleInput,
  deps: CuaTaskLifecycleDeps,
): CuaTaskLifecycleResult {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }
  if (!validTaskId(input.taskId) || !validPrivateInput(input)) {
    return failed(input.operation, "validation_failed", false);
  }
  if (input.operation === "task.start" ? input.mode === undefined : input.mode !== undefined) {
    return failed(input.operation, "validation_failed", false);
  }

  const registry = deps.load();
  const sandbox = registry.sandboxes[input.sandboxName];
  if (!sandbox) return failed(input.operation, "validation_failed", false);
  const priorReconciliation = sandbox.cuaReconciliation
    ? structuredClone(sandbox.cuaReconciliation)
    : undefined;
  if (
    priorReconciliation &&
    !cuaReconciliationAllowsOperation(priorReconciliation, input.operation, input.taskId)
  ) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }

  const storedReadiness = sandbox.cuaRuntimeReadiness;
  if (!storedReadiness) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }
  const reconciliationMode = priorReconciliation !== undefined;
  const storedReadinessDigest = getCuaRuntimeReadinessDigest(storedReadiness);
  if (
    reconciliationMode &&
    priorReconciliation.runtimeReadinessDigest !== null &&
    priorReconciliation.runtimeReadinessDigest !== storedReadinessDigest
  ) {
    return failed(input.operation, "runtime_unavailable", false, "runtime");
  }
  if (
    !reconciliationMode &&
    ((sandbox.provider !== undefined && sandbox.provider !== storedReadiness.inference.provider) ||
      (sandbox.model !== undefined && sandbox.model !== storedReadiness.inference.model))
  ) {
    quarantineCuaAuthority(sandbox, "inference-change");
    deps.save(registry);
    return failed(input.operation, "inference_unavailable", false, "inference");
  }

  let runtime = storedReadiness;
  if (!reconciliationMode) {
    try {
      runtime = (deps.requireRuntimeReadiness ?? requireCuaLifecycleReadiness)(sandbox, deps);
    } catch {
      quarantineCuaAuthority(sandbox, "readiness-change");
      deps.save(registry);
      return failed(input.operation, "runtime_unavailable", false, "runtime");
    }
  }
  if (runtime.status === "incompatible") {
    return failed(input.operation, "runtime_incompatible", false, "runtime");
  }
  if (runtime.status !== "available" && runtime.status !== "candidate") {
    return failed(input.operation, "runtime_unavailable", true, "runtime");
  }
  if (!runtime.taskOperations.includes(input.operation)) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }
  const target = sandbox.cuaTarget;
  const runtimeReadinessDigest = getCuaRuntimeReadinessDigest(runtime);
  if (
    !target?.target ||
    (!reconciliationMode && target.status !== "attached") ||
    target.runtimeReadinessDigest !== runtimeReadinessDigest
  ) {
    quarantineCuaAuthority(sandbox, "runtime-authority-change");
    deps.save(registry);
    return failed(input.operation, "target_unreachable", true, "target");
  }

  let appliedPolicy: CuaAppliedPolicyIdentity;
  if (reconciliationMode) {
    const cleanupPolicy =
      priorReconciliation.appliedPolicy ?? target.activeTask?.appliedPolicy ?? null;
    if (!cleanupPolicy) {
      return failed(input.operation, "policy_invalid", false, "policy");
    }
    appliedPolicy = cleanupPolicy;
  } else {
    try {
      appliedPolicy = requireCuaLiveAppliedPolicy(sandbox, deps);
    } catch {
      clearPolicyBoundState(sandbox);
      quarantineCuaAuthority(sandbox, "policy-change");
      deps.save(registry);
      return failed(input.operation, "policy_invalid", false, "policy");
    }

    if (
      !sandbox.cuaSecurityAttestation ||
      !cuaSecurityAttestationMatches(
        sandbox.cuaSecurityAttestation,
        runtime,
        target.target,
        appliedPolicy,
      )
    ) {
      clearPolicyBoundState(sandbox);
      if (target.activeTask) quarantineCuaAuthority(sandbox, "policy-change");
      deps.save(registry);
      return failed(input.operation, "policy_invalid", false, "policy");
    }

    if (target.activeTask && !isDeepStrictEqual(target.activeTask.appliedPolicy, appliedPolicy)) {
      clearPolicyBoundState(sandbox);
      quarantineCuaAuthority(sandbox, "policy-change");
      deps.save(registry);
      return failed(input.operation, "policy_invalid", false, "policy");
    }
  }

  let stored = matchingStoredResult(registry, input.sandboxName, input.taskId);
  if (stored && !taskResultMatches(stored, input.taskId, runtime, target.target, appliedPolicy)) {
    sandbox.cuaTaskResults = (sandbox.cuaTaskResults ?? []).filter(
      (entry) => entry.taskId !== input.taskId,
    );
    deps.save(registry);
    stored = undefined;
  }
  if (input.operation === "task.start" && stored) {
    return failed(input.operation, "validation_failed", false);
  }
  if (
    (input.operation === "task.result" || input.operation === "task.status") &&
    stored &&
    !priorReconciliation
  ) {
    return result(stored);
  }

  const active = target.activeTask;
  if (input.operation === "task.start") {
    if (active) return failed(input.operation, "task_conflict", false, "target");
  } else {
    const reconciliationStatus = input.operation === "task.status" && priorReconciliation;
    if (!reconciliationStatus && active?.taskId !== input.taskId) {
      return failed(input.operation, "validation_failed", false, "target");
    }
  }

  if (isCuaReconciliationSideEffectOperation(input.operation)) {
    beginCuaSideEffectReconciliation(
      sandbox,
      input.operation,
      input.taskId,
      undefined,
      appliedPolicy,
    );
    deps.save(registry);
    if (!deps.checkpoint?.()) {
      return failed(input.operation, "runtime_unavailable", false, "runtime");
    }
  }

  const adapterResult = invokeAdapter(input, runtime, target, appliedPolicy);
  if (!reconciliationMode) {
    try {
      assertCuaLifecycleReadinessUnchanged(
        sandbox,
        runtimeReadinessDigest,
        deps,
        deps.requireRuntimeReadiness ?? requireCuaLifecycleReadiness,
      );
    } catch {
      quarantineCuaAuthority(sandbox, "readiness-change");
      deps.save(registry);
      return failed(input.operation, "runtime_unavailable", false, "runtime");
    }
    try {
      assertCuaLiveAppliedPolicyUnchanged(sandbox, appliedPolicy, deps);
    } catch {
      clearPolicyBoundState(sandbox);
      quarantineCuaAuthority(sandbox, "policy-change");
      deps.save(registry);
      return failed(input.operation, "policy_invalid", false, "policy");
    }
  }
  if (adapterResult.kind === "failure") {
    if (adapterResult.operation !== input.operation) {
      return failed(input.operation, "validation_failed", false, "runtime");
    }
    if (persistFailureState(registry, input.sandboxName, input.taskId, adapterResult)) {
      deps.save(registry);
    }
    return result(adapterResult);
  }
  if (!operationAccepts(input.operation, adapterResult)) {
    return failed(input.operation, "validation_failed", false, "runtime");
  }

  if (adapterResult.kind === "target-attachment") {
    if (
      !activeAttachmentMatches(
        adapterResult,
        target,
        input.taskId,
        appliedPolicy,
        input.operation === "task.status" && reconciliationMode,
      )
    ) {
      return failed(input.operation, "validation_failed", false, "target");
    }
    sandbox.cuaTarget = structuredClone(adapterResult);
    if (input.operation === "task.status" && priorReconciliation) {
      recordCuaReconciliationObservation(sandbox, "task.status", sandbox.cuaTarget);
    } else if (isCuaReconciliationSideEffectOperation(input.operation)) {
      delete sandbox.cuaReconciliation;
    }
    deps.save(registry);
    return result(sandbox.cuaTarget);
  }

  if (!taskResultMatches(adapterResult, input.taskId, runtime, target.target, appliedPolicy)) {
    return failed(input.operation, "runtime_incompatible", false, "runtime");
  }
  if (input.operation === "task.cancel" && adapterResult.status !== "cancelled") {
    return failed(input.operation, "validation_failed", false, "runtime");
  }
  persistResult(registry, input.sandboxName, adapterResult);
  if (input.operation === "task.status" && priorReconciliation) {
    recordCuaReconciliationObservation(sandbox, "task.status", { ...target, activeTask: null });
  } else if (input.operation === "task.cancel" && priorReconciliation) {
    if (cuaTaskCancelCompletesReconciliation(priorReconciliation)) {
      delete sandbox.cuaReconciliation;
    } else if (isCuaAuthorityReconciliation(priorReconciliation)) {
      sandbox.cuaReconciliation = structuredClone(priorReconciliation);
      recordCuaReconciliationObservation(sandbox, "task.status", { ...target, activeTask: null });
    }
  } else if (isCuaReconciliationSideEffectOperation(input.operation)) {
    delete sandbox.cuaReconciliation;
  }
  deps.save(registry);
  return result(adapterResult);
}

export function executeCuaTaskLifecycle(
  input: CuaTaskLifecycleInput,
  deps: CuaTaskLifecycleDeps = defaultDeps,
): CuaTaskLifecycleResult {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }
  return executeCuaLifecycleRegistryTransaction({
    sandboxName: input.sandboxName,
    deps,
    execute: (working) =>
      executeLocked(input, {
        ...deps,
        ...working,
        isFrameworkEnabled: () => true,
      }),
    conflict: () => failed(input.operation, "runtime_unavailable", false, "runtime"),
  });
}
