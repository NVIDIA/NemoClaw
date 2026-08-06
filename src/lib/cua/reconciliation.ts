// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import {
  CuaAppliedPolicyIdentity,
  CuaOperation,
  CuaRuntimeReadiness,
  CuaSecurityAttestation,
  CuaTargetAttachment,
  CuaTaskResult,
  getCuaRuntimeReadinessDigest,
} from "./contract";

export const CUA_RECONCILIATION_VERSION = 1 as const;

export const CUA_RECONCILIATION_AUTHORITY_TRIGGERS = [
  "inference-change",
  "policy-change",
  "runtime-authority-change",
  "readiness-change",
  "snapshot-restore",
  "registry-recovery",
] as const;

export const CUA_RECONCILIATION_SIDE_EFFECT_OPERATIONS = [
  "target.attach",
  "target.detach",
  "target.destroy",
  "task.start",
  "task.cancel",
  "security.verify",
] as const satisfies readonly CuaOperation[];

export type CuaReconciliationAuthorityTrigger =
  (typeof CUA_RECONCILIATION_AUTHORITY_TRIGGERS)[number];
export type CuaReconciliationSideEffectOperation =
  (typeof CUA_RECONCILIATION_SIDE_EFFECT_OPERATIONS)[number];
export type CuaReconciliationTrigger =
  | CuaReconciliationAuthorityTrigger
  | CuaReconciliationSideEffectOperation
  | "unexpected-active-task";
export type CuaReconciliationPhase = "pending" | "required" | "observed";

export interface CuaReconciliationObservation {
  via: "target.health" | "task.status";
  targetStatus: CuaTargetAttachment["status"];
  runtimeReadinessDigest: string | null;
  targetIdentityDigest: string | null;
  activeTask: null | {
    taskId: string;
    status: NonNullable<CuaTargetAttachment["activeTask"]>["status"];
  };
}

/**
 * Durable journal for a CUA adapter effect whose exact external outcome is not
 * yet trusted. Its presence is a deny-by-default gate, not a public lifecycle
 * record. A fresh adapter status observation must precede an explicit cleanup
 * operation before normal lifecycle authority can be used again.
 */
export interface CuaReconciliationState {
  version: typeof CUA_RECONCILIATION_VERSION;
  phase: CuaReconciliationPhase;
  attemptId: string;
  trigger: CuaReconciliationTrigger;
  operation: CuaReconciliationSideEffectOperation | null;
  taskId: string | null;
  runtimeReadinessDigest: string | null;
  targetIdentityDigest: string | null;
  appliedPolicy: CuaAppliedPolicyIdentity | null;
  observation: CuaReconciliationObservation | null;
}

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_TASK_ID =
  /(?:auth|bearer|credential|password|secret|token)|(?:^|[/._-])(?:ghp_|sk-)/i;
const TARGET_STATUSES = new Set<CuaTargetAttachment["status"]>([
  "attached",
  "detached",
  "unreachable",
  "incompatible",
  "replaced",
]);
const ACTIVE_TASK_STATUSES = new Set<NonNullable<CuaTargetAttachment["activeTask"]>["status"]>([
  "running",
  "paused",
  "input-required",
  "cancelling",
]);
const PHASES = new Set<CuaReconciliationPhase>(["pending", "required", "observed"]);
const AUTHORITY_TRIGGERS = new Set<string>(CUA_RECONCILIATION_AUTHORITY_TRIGGERS);
const SIDE_EFFECT_OPERATIONS = new Set<string>(CUA_RECONCILIATION_SIDE_EFFECT_OPERATIONS);
const TRIGGERS = new Set<string>([
  ...CUA_RECONCILIATION_AUTHORITY_TRIGGERS,
  ...CUA_RECONCILIATION_SIDE_EFFECT_OPERATIONS,
  "unexpected-active-task",
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validDigestOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DIGEST_PATTERN.test(value));
}

function validTaskIdOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && TASK_ID_PATTERN.test(value) && !SENSITIVE_TASK_ID.test(value))
  );
}

function parseAppliedPolicy(value: unknown): CuaAppliedPolicyIdentity | null {
  if (value === null) return null;
  if (
    !isObjectRecord(value) ||
    !hasExactKeys(value, ["digest", "revision"]) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    typeof value.digest !== "string" ||
    !DIGEST_PATTERN.test(value.digest)
  ) {
    throw new Error("CUA reconciliation state has an invalid applied-policy identity");
  }
  return { revision: Number(value.revision), digest: value.digest };
}

function parseObservation(value: unknown): CuaReconciliationObservation | null {
  if (!isObjectRecord(value)) throw new Error("CUA reconciliation observation must be an object");
  if (
    !hasExactKeys(value, [
      "activeTask",
      "runtimeReadinessDigest",
      "targetIdentityDigest",
      "targetStatus",
      "via",
    ])
  ) {
    throw new Error("CUA reconciliation observation has unsupported fields");
  }
  if (value.via !== "target.health" && value.via !== "task.status") {
    throw new Error("CUA reconciliation observation has an unsupported status operation");
  }
  if (
    typeof value.targetStatus !== "string" ||
    !TARGET_STATUSES.has(value.targetStatus as CuaTargetAttachment["status"])
  ) {
    throw new Error("CUA reconciliation observation has an invalid target status");
  }
  if (
    !validDigestOrNull(value.runtimeReadinessDigest) ||
    !validDigestOrNull(value.targetIdentityDigest)
  ) {
    throw new Error("CUA reconciliation observation has an invalid identity digest");
  }

  let activeTask: CuaReconciliationObservation["activeTask"] = null;
  if (value.activeTask !== null) {
    if (
      !isObjectRecord(value.activeTask) ||
      !hasExactKeys(value.activeTask, ["status", "taskId"]) ||
      !validTaskIdOrNull(value.activeTask.taskId) ||
      value.activeTask.taskId === null ||
      typeof value.activeTask.status !== "string" ||
      !ACTIVE_TASK_STATUSES.has(
        value.activeTask.status as NonNullable<CuaTargetAttachment["activeTask"]>["status"],
      )
    ) {
      throw new Error("CUA reconciliation observation has an invalid active task");
    }
    activeTask = {
      taskId: value.activeTask.taskId,
      status: value.activeTask.status as NonNullable<CuaTargetAttachment["activeTask"]>["status"],
    };
  }

  if (value.targetStatus === "detached" && value.activeTask !== null) {
    throw new Error("A detached CUA reconciliation observation cannot contain an active task");
  }
  if (value.targetStatus === "detached" && value.targetIdentityDigest !== null) {
    throw new Error("A detached CUA reconciliation observation cannot contain a target identity");
  }
  if (value.targetStatus !== "detached" && value.targetIdentityDigest === null) {
    throw new Error("An attached CUA reconciliation observation requires a target identity");
  }

  return {
    via: value.via,
    targetStatus: value.targetStatus as CuaTargetAttachment["status"],
    runtimeReadinessDigest: value.runtimeReadinessDigest,
    targetIdentityDigest: value.targetIdentityDigest,
    activeTask,
  };
}

/** Parse the private durable reconciliation journal with a closed key set. */
export function parseCuaReconciliationState(value: unknown): CuaReconciliationState {
  if (!isObjectRecord(value)) throw new Error("CUA reconciliation state must be an object");
  if (
    !hasExactKeys(value, [
      "appliedPolicy",
      "attemptId",
      "observation",
      "operation",
      "phase",
      "runtimeReadinessDigest",
      "targetIdentityDigest",
      "taskId",
      "trigger",
      "version",
    ])
  ) {
    throw new Error("CUA reconciliation state has unsupported fields");
  }
  if (value.version !== CUA_RECONCILIATION_VERSION) {
    throw new Error("CUA reconciliation state has an unsupported version");
  }
  if (typeof value.phase !== "string" || !PHASES.has(value.phase as CuaReconciliationPhase)) {
    throw new Error("CUA reconciliation state has an invalid phase");
  }
  if (typeof value.attemptId !== "string" || !UUID_PATTERN.test(value.attemptId)) {
    throw new Error("CUA reconciliation state has an invalid attempt identity");
  }
  if (typeof value.trigger !== "string" || !TRIGGERS.has(value.trigger)) {
    throw new Error("CUA reconciliation state has an invalid trigger");
  }
  if (
    value.operation !== null &&
    (typeof value.operation !== "string" || !SIDE_EFFECT_OPERATIONS.has(value.operation))
  ) {
    throw new Error("CUA reconciliation state has an invalid lifecycle operation");
  }
  if (!validTaskIdOrNull(value.taskId)) {
    throw new Error("CUA reconciliation state has an invalid task identity");
  }
  if (!validDigestOrNull(value.runtimeReadinessDigest)) {
    throw new Error("CUA reconciliation state has an invalid runtime identity");
  }
  if (!validDigestOrNull(value.targetIdentityDigest)) {
    throw new Error("CUA reconciliation state has an invalid target identity");
  }
  const appliedPolicy = parseAppliedPolicy(value.appliedPolicy);

  const observation = value.observation === null ? null : parseObservation(value.observation);
  if (value.phase === "observed" ? observation === null : observation !== null) {
    throw new Error("CUA reconciliation phase and observation must agree");
  }
  if (value.phase === "pending" && value.operation === null) {
    throw new Error("Pending CUA reconciliation requires a side-effecting operation");
  }
  if (value.trigger === "unexpected-active-task" && value.taskId === null) {
    throw new Error("Unexpected CUA active-task reconciliation requires a task identity");
  }

  return {
    version: CUA_RECONCILIATION_VERSION,
    phase: value.phase as CuaReconciliationPhase,
    attemptId: value.attemptId,
    trigger: value.trigger as CuaReconciliationTrigger,
    operation: value.operation as CuaReconciliationSideEffectOperation | null,
    taskId: value.taskId,
    runtimeReadinessDigest: value.runtimeReadinessDigest,
    targetIdentityDigest: value.targetIdentityDigest,
    appliedPolicy,
    observation,
  };
}

export interface CreateCuaReconciliationOptions {
  phase?: Exclude<CuaReconciliationPhase, "observed">;
  attemptId?: string;
  trigger: CuaReconciliationTrigger;
  operation?: CuaReconciliationSideEffectOperation | null;
  taskId?: string | null;
  runtimeReadinessDigest?: string | null;
  targetIdentityDigest?: string | null;
  appliedPolicy?: CuaAppliedPolicyIdentity | null;
}

/** Create and self-validate a new deny-by-default reconciliation journal. */
export function createCuaReconciliationState(
  options: CreateCuaReconciliationOptions,
): CuaReconciliationState {
  const operation =
    options.operation ?? (SIDE_EFFECT_OPERATIONS.has(options.trigger) ? options.trigger : null);
  return parseCuaReconciliationState({
    version: CUA_RECONCILIATION_VERSION,
    phase: options.phase ?? "required",
    attemptId: options.attemptId ?? crypto.randomUUID(),
    trigger: options.trigger,
    operation,
    taskId: options.taskId ?? null,
    runtimeReadinessDigest: options.runtimeReadinessDigest ?? null,
    targetIdentityDigest: options.targetIdentityDigest ?? null,
    appliedPolicy: options.appliedPolicy ?? null,
    observation: null,
  });
}

/** Convert a pending/crashed adapter journal into the explicit required phase. */
export function requireCuaReconciliation(state: CuaReconciliationState): CuaReconciliationState {
  return parseCuaReconciliationState({
    ...state,
    phase: "required",
    observation: null,
  });
}

/** Bind a fresh independent adapter observation to the current quarantine. */
export function observeCuaReconciliation(
  state: CuaReconciliationState,
  via: CuaReconciliationObservation["via"],
  target: CuaTargetAttachment,
): CuaReconciliationState {
  return parseCuaReconciliationState({
    ...state,
    phase: "observed",
    operation: null,
    observation: {
      via,
      targetStatus: target.status,
      runtimeReadinessDigest: target.runtimeReadinessDigest,
      targetIdentityDigest: target.target?.identityDigest ?? null,
      activeTask: target.activeTask
        ? { taskId: target.activeTask.taskId, status: target.activeTask.status }
        : null,
    },
  });
}

export interface CuaReconciliationCarrier {
  cuaRuntimeReadiness?: CuaRuntimeReadiness;
  cuaTarget?: CuaTargetAttachment;
  cuaSecurityAttestation?: CuaSecurityAttestation;
  cuaTaskResults?: CuaTaskResult[];
  cuaReconciliation?: CuaReconciliationState;
}

export type CuaReconciliationAdapterKind = "target" | "task" | "security";

/**
 * Resolve adapter authority only through the exact readiness record captured
 * by the unresolved external effect. A current manifest is not evidence that
 * its replacement adapter owns the effect that still needs observation or
 * cleanup.
 */
export function getCuaReconciliationAdapterDigest(
  entry: CuaReconciliationCarrier,
  kind: CuaReconciliationAdapterKind,
): string | null {
  const reconciliation = entry.cuaReconciliation;
  const readiness = entry.cuaRuntimeReadiness;
  if (!reconciliation || !readiness || reconciliation.runtimeReadinessDigest === null) {
    return null;
  }
  if (getCuaRuntimeReadinessDigest(readiness) !== reconciliation.runtimeReadinessDigest) {
    return null;
  }
  if (kind === "target") return readiness.components.targetAdapter.digest;
  if (kind === "task") return readiness.components.taskProtocol.digest;
  return readiness.components.securityVerifier.digest;
}

export function hasPotentialExternalCuaEffect(entry: CuaReconciliationCarrier): boolean {
  return entry.cuaReconciliation !== undefined || entry.cuaTarget?.target != null;
}

/**
 * Invalidate local authority without erasing the target or its active task.
 * When no external effect exists, the ordinary authority chain can be cleared.
 */
export function quarantineCuaAuthority(
  entry: CuaReconciliationCarrier,
  trigger: CuaReconciliationAuthorityTrigger,
  attemptId?: string,
): boolean {
  if (!hasPotentialExternalCuaEffect(entry)) {
    delete entry.cuaRuntimeReadiness;
    delete entry.cuaTarget;
    delete entry.cuaSecurityAttestation;
    delete entry.cuaTaskResults;
    delete entry.cuaReconciliation;
    return false;
  }
  if (!entry.cuaReconciliation) {
    entry.cuaReconciliation = createCuaReconciliationState({
      trigger,
      ...(attemptId ? { attemptId } : {}),
      runtimeReadinessDigest: entry.cuaTarget?.runtimeReadinessDigest ?? null,
      targetIdentityDigest: entry.cuaTarget?.target?.identityDigest ?? null,
      taskId: entry.cuaTarget?.activeTask?.taskId ?? null,
      appliedPolicy:
        entry.cuaTarget?.activeTask?.appliedPolicy ??
        entry.cuaSecurityAttestation?.bindings.appliedPolicy ??
        null,
    });
  }
  delete entry.cuaSecurityAttestation;
  delete entry.cuaTaskResults;
  return true;
}

/** Persist this journal before invoking any side-effecting adapter operation. */
export function beginCuaSideEffectReconciliation(
  entry: CuaReconciliationCarrier,
  operation: CuaReconciliationSideEffectOperation,
  taskId: string | null = null,
  attemptId = crypto.randomUUID(),
  appliedPolicy: CuaAppliedPolicyIdentity | null = null,
): CuaReconciliationState {
  const existing = entry.cuaReconciliation;
  if (existing && !cuaReconciliationAllowsOperation(existing, operation, taskId)) {
    throw new Error("CUA reconciliation does not allow this lifecycle operation");
  }
  const state = existing
    ? parseCuaReconciliationState({
        ...existing,
        phase: "pending",
        attemptId,
        operation,
        taskId: taskId ?? existing.taskId,
        appliedPolicy: appliedPolicy ?? existing.appliedPolicy,
        observation: null,
      })
    : createCuaReconciliationState({
        phase: "pending",
        attemptId,
        trigger: operation,
        operation,
        taskId: taskId ?? entry.cuaTarget?.activeTask?.taskId ?? null,
        runtimeReadinessDigest: entry.cuaTarget?.runtimeReadinessDigest ?? null,
        targetIdentityDigest: entry.cuaTarget?.target?.identityDigest ?? null,
        appliedPolicy:
          appliedPolicy ??
          entry.cuaTarget?.activeTask?.appliedPolicy ??
          entry.cuaSecurityAttestation?.bindings.appliedPolicy ??
          null,
      });
  entry.cuaReconciliation = state;
  return state;
}

/** Retain an uncertain adapter effect after invocation, parse, or CAS failure. */
export function markCuaSideEffectReconciliationRequired(
  entry: CuaReconciliationCarrier,
  attemptId: string,
): boolean {
  if (entry.cuaReconciliation?.attemptId !== attemptId) return false;
  entry.cuaReconciliation = requireCuaReconciliation(entry.cuaReconciliation);
  return true;
}

/** Record an independent status result without hiding any observed active task. */
export function recordCuaReconciliationObservation(
  entry: CuaReconciliationCarrier,
  via: CuaReconciliationObservation["via"],
  target: CuaTargetAttachment,
  expectedTaskId: string | null = null,
): CuaReconciliationState {
  if (!entry.cuaReconciliation) {
    const taskId = target.activeTask?.taskId ?? expectedTaskId;
    if (!taskId) throw new Error("CUA reconciliation is not required");
    entry.cuaReconciliation = createCuaReconciliationState({
      trigger: "unexpected-active-task",
      taskId,
      runtimeReadinessDigest: target.runtimeReadinessDigest,
      targetIdentityDigest: target.target?.identityDigest ?? null,
      appliedPolicy: target.activeTask?.appliedPolicy ?? null,
    });
  }
  if (target.activeTask) {
    entry.cuaReconciliation = parseCuaReconciliationState({
      ...entry.cuaReconciliation,
      taskId: target.activeTask.taskId,
      appliedPolicy: target.activeTask.appliedPolicy,
    });
  }
  entry.cuaTarget = structuredClone(target);
  entry.cuaReconciliation = observeCuaReconciliation(entry.cuaReconciliation, via, target);
  return entry.cuaReconciliation;
}

export function isCuaReconciliationSideEffectOperation(
  operation: CuaOperation,
): operation is CuaReconciliationSideEffectOperation {
  return SIDE_EFFECT_OPERATIONS.has(operation);
}

export function isCuaAuthorityReconciliation(state: CuaReconciliationState): boolean {
  return AUTHORITY_TRIGGERS.has(state.trigger);
}

/**
 * Only independent status probes are legal before observation. Cleanup is
 * legal afterward, and an active task must be cancelled before target cleanup.
 */
export function cuaReconciliationAllowsOperation(
  state: CuaReconciliationState,
  operation: CuaOperation,
  taskId: string | null = null,
): boolean {
  if (operation === "target.health" || operation === "task.status") return true;
  if (state.phase !== "observed" || !state.observation) return false;
  if (operation === "task.cancel") {
    return state.observation.activeTask?.taskId === taskId;
  }
  if (operation === "target.destroy") {
    return state.observation.activeTask === null;
  }
  return false;
}

/** A validated task cancel alone resolves only task-scoped uncertainty. */
export function cuaTaskCancelCompletesReconciliation(state: CuaReconciliationState): boolean {
  return (
    state.trigger === "unexpected-active-task" ||
    (typeof state.trigger === "string" && state.trigger.startsWith("task."))
  );
}
