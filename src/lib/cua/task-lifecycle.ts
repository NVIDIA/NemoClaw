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
  type CuaCapability,
  type CuaFailure,
  type CuaFailureFamily,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
  type CuaTaskEvidenceIndex,
  type CuaTaskResult,
} from "./contract";
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
  record: CuaTargetAttachment | CuaTaskEvidenceIndex | CuaTaskResult | CuaFailure;
  exitCode: number;
}

export interface CuaTaskLifecycleDeps {
  load: () => SandboxRegistry;
  save: (registry: SandboxRegistry) => void;
  withLock: <T>(fn: () => T) => T;
}

const defaultDeps: CuaTaskLifecycleDeps = { load, save, withLock };
const MAX_TASK_INPUT_BYTES = 64 * 1024;
const MAX_COMPLETED_RESULTS = 16;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

function result(
  record: CuaTargetAttachment | CuaTaskEvidenceIndex | CuaTaskResult | CuaFailure,
): CuaTaskLifecycleResult {
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
  const requiresInput =
    input.operation === "task.start" ||
    input.operation === "task.guide" ||
    input.operation === "task.respond";
  if (requiresInput !== (input.input !== undefined)) return false;
  if (input.input === undefined) return true;
  return input.input.length > 0 && Buffer.byteLength(input.input, "utf8") <= MAX_TASK_INPUT_BYTES;
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
    .map(({ id, protocolVersion }) => ({ id, protocolVersion }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function taskResultMatches(
  taskResult: CuaTaskResult,
  taskId: string,
  runtime: CuaRuntimeReadiness,
  target: NonNullable<CuaTargetAttachment["target"]>,
): boolean {
  return (
    taskResult.taskId === taskId &&
    taskResult.targetIdentityDigest === target.identityDigest &&
    isDeepStrictEqual(taskResult.components.runtime, runtime.components.runtime) &&
    isDeepStrictEqual(taskResult.components.sandboxImage, runtime.components.sandboxImage) &&
    isDeepStrictEqual(taskResult.components.policy, runtime.components.policy) &&
    isDeepStrictEqual(taskResult.components.taskProtocol, runtime.components.taskProtocol) &&
    isDeepStrictEqual(taskResult.components.targetImage, target.image) &&
    isDeepStrictEqual(taskResult.components.serviceBundle, target.serviceBundle) &&
    isDeepStrictEqual(taskResult.inference, runtime.inference) &&
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
): boolean {
  return (
    observed.status === "attached" &&
    observed.target !== null &&
    current.target !== null &&
    observed.activeTask?.taskId === taskId &&
    isDeepStrictEqual(observed.target, current.target)
  );
}

function expectedEvidenceCategory(
  operation: CuaTaskOperation,
): CuaTaskEvidenceIndex["category"] | null {
  if (operation === "task.events") return "events";
  if (operation === "task.logs") return "logs";
  if (operation === "task.plans") return "plans";
  return null;
}

function invokeAdapter(
  input: CuaTaskLifecycleInput,
  runtime: CuaRuntimeReadiness,
  target: CuaTargetAttachment,
): CuaTaskAdapterResult {
  if (!input.adapter) return failure(input.operation, "lifecycle_unavailable", false, "runtime");
  try {
    return input.adapter.execute({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "task-adapter-request",
      operation: input.operation,
      sandboxName: input.sandboxName,
      taskId: input.taskId,
      mode: input.mode ?? null,
      input: input.input ?? null,
      runtime,
      target,
    });
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
  if (operation === "task.events" || operation === "task.logs" || operation === "task.plans") {
    return adapterResult.kind === "task-evidence-index";
  }
  if (operation === "task.result" || operation === "task.cancel") {
    return adapterResult.kind === "task-result";
  }
  if (operation === "task.status") {
    return adapterResult.kind === "target-attachment" || adapterResult.kind === "task-result";
  }
  if (operation === "task.pause") {
    return (
      adapterResult.kind === "target-attachment" && adapterResult.activeTask?.status === "paused"
    );
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
  if (failureRecord.family === "task_timeout" || failureRecord.family === "task_cancelled") {
    target.activeTask = null;
    return true;
  }
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
  target.activeTask = null;
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
  if (!TASK_ID_PATTERN.test(input.taskId) || !validPrivateInput(input)) {
    return failed(input.operation, "validation_failed", false);
  }
  if (input.operation === "task.start" ? input.mode === undefined : input.mode !== undefined) {
    return failed(input.operation, "validation_failed", false);
  }

  const registry = deps.load();
  const sandbox = registry.sandboxes[input.sandboxName];
  if (!sandbox) return failed(input.operation, "validation_failed", false);

  const runtime = sandbox.cuaRuntimeReadiness;
  if (!runtime) return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  if (runtime.status === "incompatible") {
    return failed(input.operation, "runtime_incompatible", false, "runtime");
  }
  if (runtime.status !== "available") {
    return failed(input.operation, "runtime_unavailable", true, "runtime");
  }
  if (!runtime.taskOperations.includes(input.operation)) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }

  const stored = matchingStoredResult(registry, input.sandboxName, input.taskId);
  if (input.operation === "task.start" && stored) {
    return failed(input.operation, "validation_failed", false);
  }
  if ((input.operation === "task.result" || input.operation === "task.status") && stored) {
    return result(stored);
  }

  const target = sandbox.cuaTarget;
  if (!target?.target || target.status !== "attached") {
    return failed(input.operation, "target_unreachable", true, "target");
  }
  if (
    !sandbox.cuaSecurityAttestation ||
    !cuaSecurityAttestationMatches(sandbox.cuaSecurityAttestation, runtime, target.target)
  ) {
    return failed(input.operation, "policy_invalid", false, "policy");
  }

  const active = target.activeTask;
  if (input.operation === "task.start") {
    if (active) return failed(input.operation, "task_conflict", false, "target");
  } else {
    const evidenceForCompleted =
      stored &&
      (input.operation === "task.events" ||
        input.operation === "task.logs" ||
        input.operation === "task.plans");
    if (!evidenceForCompleted && active?.taskId !== input.taskId) {
      return failed(input.operation, "validation_failed", false, "target");
    }
    if (input.operation === "task.respond" && active?.status !== "input-required") {
      return failed(input.operation, "validation_failed", false, "target");
    }
  }

  const adapterResult = invokeAdapter(input, runtime, target);
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
    if (!activeAttachmentMatches(adapterResult, target, input.taskId)) {
      return failed(input.operation, "validation_failed", false, "target");
    }
    sandbox.cuaTarget = structuredClone(adapterResult);
    deps.save(registry);
    return result(sandbox.cuaTarget);
  }

  if (adapterResult.kind === "task-evidence-index") {
    const category = expectedEvidenceCategory(input.operation);
    if (
      adapterResult.taskId !== input.taskId ||
      adapterResult.targetIdentityDigest !== target.target.identityDigest ||
      adapterResult.category !== category
    ) {
      return failed(input.operation, "validation_failed", false, "target");
    }
    return result(adapterResult);
  }

  if (!taskResultMatches(adapterResult, input.taskId, runtime, target.target)) {
    return failed(input.operation, "runtime_incompatible", false, "runtime");
  }
  if (
    adapterResult.status === "succeeded" &&
    (adapterResult.agentResult.status !== "succeeded" ||
      adapterResult.verification.status !== "passed")
  ) {
    return failed(input.operation, "validation_failed", false, "runtime");
  }
  if (input.operation === "task.cancel" && adapterResult.status !== "cancelled") {
    return failed(input.operation, "validation_failed", false, "runtime");
  }
  persistResult(registry, input.sandboxName, adapterResult);
  deps.save(registry);
  return result(adapterResult);
}

export function executeCuaTaskLifecycle(
  input: CuaTaskLifecycleInput,
  deps: CuaTaskLifecycleDeps = defaultDeps,
): CuaTaskLifecycleResult {
  return deps.withLock(() => executeLocked(input, deps));
}
