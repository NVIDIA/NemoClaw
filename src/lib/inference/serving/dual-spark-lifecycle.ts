// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";

import {
  DUAL_SPARK_API_KEY_FINGERPRINT_LABEL,
  DUAL_SPARK_MANAGED_LABEL,
  DUAL_SPARK_TRANSACTION_LABEL,
  DUAL_SPARK_VLLM_API_PORT,
  DUAL_SPARK_VLLM_IMAGE,
  DUAL_SPARK_VLLM_MASTER_PORT,
  DUAL_SPARK_VLLM_PROJECT_ID,
  type DualSparkVllmPlan,
  type DualSparkVllmRolePlan,
} from "./dual-spark-materialize.js";

const API_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/;
const FINGERPRINT_CONTEXT = "nemoclaw-dual-dgx-spark-vllm-api-key\0";
const STATION_CONTAINER_NAMES = new Set(["nemoclaw-vllm", "nemoclaw-vllm-worker"]);
const STATION_LABEL_PREFIX = "com.nvidia.nemoclaw.vllm-";
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const VLLM_TOKEN_PATTERN = /(?:^|[./:_-])vllm(?:$|[./:@_-])/i;

export interface DualSparkObservedContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly running: boolean;
  /** True only after the executor's bounded role-specific readiness check. */
  readonly healthy: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

export interface DualSparkNodeSnapshot {
  /** All containers visible to the node daemon, including stopped containers. */
  readonly containers: readonly DualSparkObservedContainer[];
  /** Host-network listeners. The executor must inspect both requested ports. */
  readonly listeningPorts: readonly number[];
}

export type DualSparkExistingState =
  | { readonly outcome: "clear" }
  | {
      readonly outcome: "reuse";
      readonly headContainerId: string;
      readonly workerContainerId: string;
      readonly transactionId: string;
    }
  | { readonly outcome: "conflict"; readonly reason: string }
  | { readonly outcome: "unknown"; readonly reason: string };

export interface DualSparkStageRequest {
  readonly rolePlan: DualSparkVllmRolePlan;
  /** Verify or fetch only the pinned model snapshot and immutable image. */
  readonly preparation: DualSparkVllmRolePlan["preparation"];
}

export interface DualSparkContainerStartRequest {
  readonly rolePlan: DualSparkVllmRolePlan;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The executor performs this code-owned preparation inside the newly
   * created container, then directly execs the role command. Copy/replace
   * operations must match exactly or creation fails before vLLM starts.
   */
  readonly preparation: DualSparkVllmRolePlan["preparation"];
  /** Present only for the head. The executor must not persist it in labels or the plan. */
  readonly bearerApiKey?: string;
}

export interface DualSparkContainerStartResult {
  readonly ok: boolean;
  readonly containerId?: string;
  readonly reason?: string;
}

export interface DualSparkContainerWaitRequest {
  readonly rolePlan: DualSparkVllmRolePlan;
  readonly containerId: string;
  readonly expectedLabels: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface DualSparkApiProbeRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly expectedModel: string;
  readonly timeoutMs: number;
}

/**
 * Production integration supplies one executor that resolves the opaque SSH
 * binding in each worker role plan and performs Docker operations using argv,
 * never a caller-built command string.
 */
export interface DualSparkVllmLifecycleDeps {
  inspectNode(rolePlan: DualSparkVllmRolePlan): Promise<DualSparkNodeSnapshot>;
  stageNode(request: DualSparkStageRequest): Promise<{ ok: boolean; reason?: string }>;
  startContainer(request: DualSparkContainerStartRequest): Promise<DualSparkContainerStartResult>;
  waitForContainerReady(request: DualSparkContainerWaitRequest): Promise<boolean>;
  /** Prove the rank-1 process is alive and waiting at the distributed rendezvous. */
  waitForWorkerDistributedReady(request: DualSparkContainerWaitRequest): Promise<boolean>;
  removeContainer(
    rolePlan: DualSparkVllmRolePlan,
    exactContainerId: string,
  ): Promise<{ ok: boolean; reason?: string }>;
  probeModels(request: DualSparkApiProbeRequest): Promise<boolean>;
  probeChat(request: DualSparkApiProbeRequest): Promise<boolean>;
  createTransactionId(): string;
  withLifecycleLock<T>(plan: DualSparkVllmPlan, operation: () => Promise<T>): Promise<T>;
}

export interface DualSparkRuntimeInspection {
  readonly state: DualSparkExistingState;
  readonly snapshots?: {
    readonly head: DualSparkNodeSnapshot;
    readonly worker: DualSparkNodeSnapshot;
  };
}

export type CleanupDualSparkVllmResult =
  | {
      readonly ok: true;
      readonly removedContainerIds: readonly string[];
      readonly alreadyAbsentContainerIds?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly removedContainerIds: readonly string[];
    };

export interface DualSparkCleanupOwnership {
  readonly headContainerId: string;
  readonly workerContainerId: string;
}

export type StartDualSparkVllmResult =
  | {
      readonly ok: true;
      readonly reusedExisting: boolean;
      readonly baseUrl: string;
      readonly headContainerId: string;
      readonly workerContainerId: string;
      readonly apiKeyFingerprint: string;
    }
  | {
      readonly ok: false;
      readonly code: "conflict" | "unknown" | "staging-failed" | "start-failed" | "health-failed";
      readonly reason: string;
      readonly rollbackErrors: readonly string[];
    };

interface RoleObservation {
  rolePlan: DualSparkVllmRolePlan;
  container: DualSparkObservedContainer;
  expectedLabels: Readonly<Record<string, string>>;
}

interface CreatedContainer {
  rolePlan: DualSparkVllmRolePlan;
  containerId: string;
  expectedLabels: Readonly<Record<string, string>>;
}

function labelsMatch(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function exactRoleObservation(
  snapshot: DualSparkNodeSnapshot,
  rolePlan: DualSparkVllmRolePlan,
  apiKeyFingerprint: string,
): RoleObservation | null {
  const matches = snapshot.containers.filter(({ name }) => name === rolePlan.containerName);
  if (matches.length !== 1) return null;
  const container = matches[0]!;
  const transactionId = container.labels[DUAL_SPARK_TRANSACTION_LABEL] ?? "";
  const expectedLabels = {
    ...rolePlan.baseLabels,
    [DUAL_SPARK_API_KEY_FINGERPRINT_LABEL]: apiKeyFingerprint,
    [DUAL_SPARK_TRANSACTION_LABEL]: transactionId,
  };
  if (
    !CONTAINER_ID_PATTERN.test(container.id) ||
    !TRANSACTION_ID_PATTERN.test(transactionId) ||
    container.image !== rolePlan.image ||
    !labelsMatch(container.labels, expectedLabels)
  ) {
    return null;
  }
  return { rolePlan, container, expectedLabels };
}

/** Recognize only containers that declare or visibly identify a vLLM runtime. */
export function isRelatedManagedVllmContainer(container: DualSparkObservedContainer): boolean {
  if (STATION_CONTAINER_NAMES.has(container.name)) return true;
  if (VLLM_TOKEN_PATTERN.test(container.name) || VLLM_TOKEN_PATTERN.test(container.image)) {
    return true;
  }
  if (Object.hasOwn(container.labels, DUAL_SPARK_MANAGED_LABEL)) return true;
  if (container.labels[COMPOSE_PROJECT_LABEL] === DUAL_SPARK_VLLM_PROJECT_ID) return true;
  if (container.labels[COMPOSE_SERVICE_LABEL] === "vllm-dspark") return true;
  return Object.keys(container.labels).some((key) => key.startsWith(STATION_LABEL_PREFIX));
}

function invalidSnapshotReason(snapshot: DualSparkNodeSnapshot, node: string): string | null {
  if (
    snapshot.listeningPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    return `${node} listener inspection is malformed`;
  }
  const ids = snapshot.containers.map(({ id }) => id);
  if (ids.some((id) => !CONTAINER_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    return `${node} container inspection is malformed or ambiguous`;
  }
  return null;
}

/** Pure, fail-closed classification shared by discovery and lifecycle preflight. */
export function classifyDualSparkExistingState(
  plan: DualSparkVllmPlan,
  apiKeyFingerprint: string,
  snapshots: {
    readonly head: DualSparkNodeSnapshot;
    readonly worker: DualSparkNodeSnapshot;
  },
): DualSparkExistingState {
  if (!/^[a-f0-9]{64}$/.test(apiKeyFingerprint)) {
    return { outcome: "unknown", reason: "dual-Spark API key fingerprint is invalid" };
  }
  for (const [node, snapshot] of [
    ["head", snapshots.head],
    ["worker", snapshots.worker],
  ] as const) {
    const invalid = invalidSnapshotReason(snapshot, node);
    if (invalid) return { outcome: "unknown", reason: invalid };
  }

  const head = exactRoleObservation(snapshots.head, plan.roles.head, apiKeyFingerprint);
  const worker = exactRoleObservation(snapshots.worker, plan.roles.worker, apiKeyFingerprint);
  const allContainers = [...snapshots.head.containers, ...snapshots.worker.containers];
  const exactIds = new Set([head?.container.id, worker?.container.id].filter(Boolean));
  const unexpectedRelated = allContainers.find(
    (container) => isRelatedManagedVllmContainer(container) && !exactIds.has(container.id),
  );
  if (unexpectedRelated) {
    return {
      outcome: "conflict",
      reason: `existing related container ${unexpectedRelated.name} is not the exact managed pair`,
    };
  }

  if (head || worker) {
    if (!head || !worker) {
      return { outcome: "conflict", reason: "managed dual-Spark deployment is incomplete" };
    }
    const headTransaction = head.container.labels[DUAL_SPARK_TRANSACTION_LABEL]!;
    const workerTransaction = worker.container.labels[DUAL_SPARK_TRANSACTION_LABEL]!;
    if (headTransaction !== workerTransaction) {
      return { outcome: "conflict", reason: "managed dual-Spark transaction labels do not match" };
    }
    if (
      !head.container.running ||
      !head.container.healthy ||
      !worker.container.running ||
      !worker.container.healthy
    ) {
      return {
        outcome: "conflict",
        reason: "managed dual-Spark deployment is stopped, incomplete, or unhealthy",
      };
    }
    return {
      outcome: "reuse",
      headContainerId: head.container.id,
      workerContainerId: worker.container.id,
      transactionId: headTransaction,
    };
  }

  const dedicatedNameExists = allContainers.some(
    ({ name }) =>
      name === plan.roles.head.containerName || name === plan.roles.worker.containerName,
  );
  if (dedicatedNameExists) {
    return { outcome: "conflict", reason: "dual-Spark container name ownership is foreign" };
  }
  for (const [node, snapshot] of [
    ["head", snapshots.head],
    ["worker", snapshots.worker],
  ] as const) {
    const occupied = snapshot.listeningPorts.find(
      (port) => port === DUAL_SPARK_VLLM_API_PORT || port === DUAL_SPARK_VLLM_MASTER_PORT,
    );
    if (occupied !== undefined) {
      return { outcome: "conflict", reason: `${node} port ${String(occupied)} is already in use` };
    }
  }
  return { outcome: "clear" };
}

/** Domain-separated non-secret ownership binding for the managed endpoint key. */
export function dualSparkVllmApiKeyFingerprint(apiKey: string): string {
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error("Dual-Spark vLLM API key must be 64 lowercase hexadecimal characters.");
  }
  return createHmac("sha256", Buffer.from(apiKey, "hex")).update(FINGERPRINT_CONTEXT).digest("hex");
}

async function inspectBoth(
  plan: DualSparkVllmPlan,
  deps: Pick<DualSparkVllmLifecycleDeps, "inspectNode">,
): Promise<{ head: DualSparkNodeSnapshot; worker: DualSparkNodeSnapshot } | null> {
  try {
    const [head, worker] = await Promise.all([
      deps.inspectNode(plan.roles.head),
      deps.inspectNode(plan.roles.worker),
    ]);
    return { head, worker };
  } catch {
    return null;
  }
}

/** Inspect both daemons before any image, cache, or container mutation. */
export async function preflightDualSparkVllm(
  plan: DualSparkVllmPlan,
  apiKey: string,
  deps: Pick<DualSparkVllmLifecycleDeps, "inspectNode">,
): Promise<DualSparkExistingState> {
  let fingerprint: string;
  try {
    fingerprint = dualSparkVllmApiKeyFingerprint(apiKey);
  } catch (error) {
    return { outcome: "unknown", reason: (error as Error).message };
  }
  const snapshots = await inspectBoth(plan, deps);
  return snapshots
    ? classifyDualSparkExistingState(plan, fingerprint, snapshots)
    : { outcome: "unknown", reason: "could not inspect both dual-Spark container daemons" };
}

/** Plan- and key-specific read-only inspection for installer/runtime recovery. */
export async function inspectDualSparkManagedRuntime(
  plan: DualSparkVllmPlan,
  apiKey: string,
  deps: Pick<DualSparkVllmLifecycleDeps, "inspectNode">,
): Promise<DualSparkRuntimeInspection> {
  let fingerprint: string;
  try {
    fingerprint = dualSparkVllmApiKeyFingerprint(apiKey);
  } catch (error) {
    return { state: { outcome: "unknown", reason: (error as Error).message } };
  }
  const snapshots = await inspectBoth(plan, deps);
  return snapshots
    ? { state: classifyDualSparkExistingState(plan, fingerprint, snapshots), snapshots }
    : {
        state: {
          outcome: "unknown",
          reason: "could not inspect both dual-Spark container daemons",
        },
      };
}

function labelsForStart(
  rolePlan: DualSparkVllmRolePlan,
  apiKeyFingerprint: string,
  transactionId: string,
): Readonly<Record<string, string>> {
  return {
    ...rolePlan.baseLabels,
    [DUAL_SPARK_API_KEY_FINGERPRINT_LABEL]: apiKeyFingerprint,
    [DUAL_SPARK_TRANSACTION_LABEL]: transactionId,
  };
}

function exactCreatedContainer(
  snapshot: DualSparkNodeSnapshot,
  created: CreatedContainer,
): DualSparkObservedContainer | null {
  const matches = snapshot.containers.filter(({ id }) => id === created.containerId);
  if (matches.length !== 1) return null;
  const container = matches[0]!;
  return container.name === created.rolePlan.containerName &&
    container.image === created.rolePlan.image &&
    labelsMatch(container.labels, created.expectedLabels)
    ? container
    : null;
}

async function rollbackCreated(
  created: readonly CreatedContainer[],
  deps: DualSparkVllmLifecycleDeps,
): Promise<string[]> {
  const errors: string[] = [];
  for (const item of [...created].reverse()) {
    let snapshot: DualSparkNodeSnapshot;
    try {
      snapshot = await deps.inspectNode(item.rolePlan);
    } catch {
      errors.push(`${item.rolePlan.role} rollback ownership could not be inspected`);
      continue;
    }
    if (!exactCreatedContainer(snapshot, item)) {
      errors.push(`${item.rolePlan.role} rollback ownership changed; container was left untouched`);
      continue;
    }
    try {
      const removed = await deps.removeContainer(item.rolePlan, item.containerId);
      if (!removed.ok) {
        errors.push(removed.reason ?? `${item.rolePlan.role} rollback removal failed`);
      }
    } catch {
      errors.push(`${item.rolePlan.role} rollback removal failed`);
    }
  }
  return errors;
}

async function rollbackCreatedAndProveClear(
  plan: DualSparkVllmPlan,
  apiKeyFingerprint: string,
  created: readonly CreatedContainer[],
  deps: DualSparkVllmLifecycleDeps,
): Promise<string[]> {
  const rollbackErrors = await rollbackCreated(created, deps);
  const snapshots = await inspectBoth(plan, deps);
  if (
    snapshots &&
    classifyDualSparkExistingState(plan, apiKeyFingerprint, snapshots).outcome === "clear"
  ) {
    return [];
  }
  return [
    ...rollbackErrors,
    "dual-Spark post-failure runtime state could not be proven clear; SSH ownership state was retained",
  ];
}

async function startRole(
  rolePlan: DualSparkVllmRolePlan,
  apiKey: string,
  apiKeyFingerprint: string,
  transactionId: string,
  timeoutMs: number,
  deps: DualSparkVllmLifecycleDeps,
): Promise<
  | { ok: true; created: CreatedContainer }
  | { ok: false; reason: string; created?: CreatedContainer }
> {
  const expectedLabels = labelsForStart(rolePlan, apiKeyFingerprint, transactionId);
  let started: DualSparkContainerStartResult;
  try {
    started = await deps.startContainer({
      rolePlan,
      labels: expectedLabels,
      preparation: rolePlan.preparation,
      ...(rolePlan.role === "head" ? { bearerApiKey: apiKey } : {}),
    });
  } catch {
    return { ok: false, reason: `${rolePlan.role} container start failed` };
  }
  const containerId = started.containerId ?? "";
  if (!CONTAINER_ID_PATTERN.test(containerId)) {
    return {
      ok: false,
      reason: started.reason ?? `${rolePlan.role} container start returned no exact container ID`,
    };
  }
  const created = { rolePlan, containerId, expectedLabels };
  if (!started.ok) {
    return {
      ok: false,
      reason: started.reason ?? `${rolePlan.role} container start failed`,
      created,
    };
  }
  let ready = false;
  try {
    const waitRequest = {
      rolePlan,
      containerId,
      expectedLabels,
      timeoutMs,
    };
    ready =
      rolePlan.role === "worker"
        ? await deps.waitForWorkerDistributedReady(waitRequest)
        : await deps.waitForContainerReady(waitRequest);
  } catch {
    ready = false;
  }
  if (!ready)
    return { ok: false, reason: `${rolePlan.role} container did not become ready`, created };

  let snapshot: DualSparkNodeSnapshot;
  try {
    snapshot = await deps.inspectNode(rolePlan);
  } catch {
    return {
      ok: false,
      reason: `${rolePlan.role} container ownership could not be revalidated`,
      created,
    };
  }
  const observed = exactCreatedContainer(snapshot, created);
  if (!observed?.running || !observed.healthy) {
    return { ok: false, reason: `${rolePlan.role} container ownership or health changed`, created };
  }
  return { ok: true, created };
}

function failure(
  code: Extract<StartDualSparkVllmResult, { ok: false }>["code"],
  reason: string,
  rollbackErrors: readonly string[] = [],
): StartDualSparkVllmResult {
  return { ok: false, code, reason, rollbackErrors };
}

async function probeManagedApi(
  plan: DualSparkVllmPlan,
  apiKey: string,
  deps: Pick<DualSparkVllmLifecycleDeps, "probeModels" | "probeChat">,
): Promise<boolean> {
  const baseUrl = plan.roles.head.endpoint;
  if (!baseUrl) return false;
  const request = {
    baseUrl,
    apiKey,
    expectedModel: plan.readiness.expectedModel,
    timeoutMs: plan.readiness.timeoutMs,
  };
  try {
    if (!(await deps.probeModels(request))) return false;
    return await deps.probeChat({ ...request, timeoutMs: Math.min(request.timeoutMs, 120_000) });
  } catch {
    return false;
  }
}

async function startNewPair(
  plan: DualSparkVllmPlan,
  apiKey: string,
  apiKeyFingerprint: string,
  deps: DualSparkVllmLifecycleDeps,
): Promise<StartDualSparkVllmResult> {
  const staged = await Promise.all(
    [plan.roles.worker, plan.roles.head].map(async (rolePlan) => {
      try {
        return await deps.stageNode({ rolePlan, preparation: rolePlan.preparation });
      } catch {
        return { ok: false, reason: `${rolePlan.role} staging failed` };
      }
    }),
  );
  const failedStage = staged.find((result) => !result.ok);
  if (failedStage) {
    return failure("staging-failed", failedStage.reason ?? "dual-Spark staging failed");
  }

  const afterStageSnapshots = await inspectBoth(plan, deps);
  if (!afterStageSnapshots) {
    return failure("unknown", "could not re-inspect both daemons after staging");
  }
  const afterStage = classifyDualSparkExistingState(plan, apiKeyFingerprint, afterStageSnapshots);
  if (afterStage.outcome !== "clear") {
    return failure(
      afterStage.outcome === "unknown" ? "unknown" : "conflict",
      `dual-Spark ownership changed during staging: ${
        "reason" in afterStage ? afterStage.reason : afterStage.outcome
      }`,
    );
  }

  const transactionId = deps.createTransactionId();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    return failure("unknown", "dual-Spark lifecycle transaction ID is invalid");
  }

  const created: CreatedContainer[] = [];
  const worker = await startRole(
    plan.roles.worker,
    apiKey,
    apiKeyFingerprint,
    transactionId,
    plan.readiness.timeoutMs,
    deps,
  );
  if (!worker.ok) {
    if (worker.created) created.push(worker.created);
    return failure(
      "start-failed",
      worker.reason,
      await rollbackCreatedAndProveClear(plan, apiKeyFingerprint, created, deps),
    );
  }
  created.push(worker.created);

  const head = await startRole(
    plan.roles.head,
    apiKey,
    apiKeyFingerprint,
    transactionId,
    plan.readiness.timeoutMs,
    deps,
  );
  if (!head.ok) {
    if (head.created) created.push(head.created);
    return failure(
      "start-failed",
      head.reason,
      await rollbackCreatedAndProveClear(plan, apiKeyFingerprint, created, deps),
    );
  }
  created.push(head.created);

  if (!(await probeManagedApi(plan, apiKey, deps))) {
    return failure(
      "health-failed",
      "dual-Spark models or chat health check failed",
      await rollbackCreatedAndProveClear(plan, apiKeyFingerprint, created, deps),
    );
  }

  const finalSnapshots = await inspectBoth(plan, deps);
  const finalState = finalSnapshots
    ? classifyDualSparkExistingState(plan, apiKeyFingerprint, finalSnapshots)
    : null;
  if (
    !finalState ||
    finalState.outcome !== "reuse" ||
    finalState.transactionId !== transactionId ||
    finalState.headContainerId !== head.created.containerId ||
    finalState.workerContainerId !== worker.created.containerId
  ) {
    return failure(
      "health-failed",
      "dual-Spark ownership changed before lifecycle commit",
      await rollbackCreatedAndProveClear(plan, apiKeyFingerprint, created, deps),
    );
  }
  return {
    ok: true,
    reusedExisting: false,
    baseUrl: plan.roles.head.endpoint!,
    headContainerId: head.created.containerId,
    workerContainerId: worker.created.containerId,
    apiKeyFingerprint,
  };
}

/**
 * Automatic lifecycle: exact healthy reuse or clean worker-first creation.
 * Stopped, partial, mismatched, Station, singleton, and foreign deployments
 * are never repaired or replaced.
 */
export async function startAutomaticDualSparkVllm(
  plan: DualSparkVllmPlan,
  apiKey: string,
  deps: DualSparkVllmLifecycleDeps,
): Promise<StartDualSparkVllmResult> {
  let apiKeyFingerprint: string;
  try {
    apiKeyFingerprint = dualSparkVllmApiKeyFingerprint(apiKey);
  } catch (error) {
    return failure("unknown", (error as Error).message);
  }

  try {
    return await deps.withLifecycleLock(plan, async () => {
      const preflight = await preflightDualSparkVllm(plan, apiKey, deps);
      if (preflight.outcome === "unknown" || preflight.outcome === "conflict") {
        return failure(preflight.outcome, preflight.reason);
      }
      if (preflight.outcome === "reuse") {
        if (!(await probeManagedApi(plan, apiKey, deps))) {
          return failure(
            "conflict",
            "existing managed dual-Spark API is unhealthy; no repair attempted",
          );
        }
        return {
          ok: true,
          reusedExisting: true,
          baseUrl: plan.roles.head.endpoint!,
          headContainerId: preflight.headContainerId,
          workerContainerId: preflight.workerContainerId,
          apiKeyFingerprint,
        };
      }
      return await startNewPair(plan, apiKey, apiKeyFingerprint, deps);
    });
  } catch (error) {
    return failure("unknown", `dual-Spark lifecycle failed: ${(error as Error).message}`);
  }
}

function exactPairForCleanup(
  plan: DualSparkVllmPlan,
  apiKeyFingerprint: string,
  snapshots: { readonly head: DualSparkNodeSnapshot; readonly worker: DualSparkNodeSnapshot },
): { head: RoleObservation; worker: RoleObservation } | null {
  const head = exactRoleObservation(snapshots.head, plan.roles.head, apiKeyFingerprint);
  const worker = exactRoleObservation(snapshots.worker, plan.roles.worker, apiKeyFingerprint);
  if (!head || !worker) return null;
  const transactionId = head.container.labels[DUAL_SPARK_TRANSACTION_LABEL];
  if (!transactionId || transactionId !== worker.container.labels[DUAL_SPARK_TRANSACTION_LABEL]) {
    return null;
  }
  const exactIds = new Set([head.container.id, worker.container.id]);
  const related = [...snapshots.head.containers, ...snapshots.worker.containers].find(
    (container) => isRelatedManagedVllmContainer(container) && !exactIds.has(container.id),
  );
  return related ? null : { head, worker };
}

function receiptOwnedTargetsForCleanup(
  plan: DualSparkVllmPlan,
  apiKeyFingerprint: string,
  snapshots: { readonly head: DualSparkNodeSnapshot; readonly worker: DualSparkNodeSnapshot },
  ownership: DualSparkCleanupOwnership,
):
  | {
      readonly ok: true;
      readonly observations: readonly RoleObservation[];
      readonly alreadyAbsentContainerIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string } {
  const expectedIds = [ownership.headContainerId, ownership.workerContainerId];
  if (
    expectedIds.some((id) => !CONTAINER_ID_PATTERN.test(id)) ||
    ownership.headContainerId === ownership.workerContainerId
  ) {
    return { ok: false, reason: "dual-Spark cleanup receipt identities are invalid" };
  }

  const observations: RoleObservation[] = [];
  const alreadyAbsentContainerIds: string[] = [];
  let transactionId: string | null = null;
  for (const [role, snapshot, expectedId] of [
    ["head", snapshots.head, ownership.headContainerId],
    ["worker", snapshots.worker, ownership.workerContainerId],
  ] as const) {
    const invalid = invalidSnapshotReason(snapshot, role);
    if (invalid) return { ok: false, reason: invalid };
    const related = snapshot.containers.filter(isRelatedManagedVllmContainer);
    const expected = snapshot.containers.find(({ id }) => id === expectedId);
    if (!expected) {
      if (related.length > 0) {
        return {
          ok: false,
          reason: `${role} receipt-owned container is absent but related runtime state exists`,
        };
      }
      alreadyAbsentContainerIds.push(expectedId);
      continue;
    }
    const observation = exactRoleObservation(snapshot, plan.roles[role], apiKeyFingerprint);
    if (
      !observation ||
      observation.container.id !== expectedId ||
      related.some(({ id }) => id !== expectedId)
    ) {
      return { ok: false, reason: `${role} receipt-owned container identity changed` };
    }
    const observedTransaction = observation.container.labels[DUAL_SPARK_TRANSACTION_LABEL]!;
    if (transactionId !== null && transactionId !== observedTransaction) {
      return { ok: false, reason: "dual-Spark receipt-owned transaction identity changed" };
    }
    transactionId = observedTransaction;
    observations.push(observation);
  }
  return { ok: true, observations, alreadyAbsentContainerIds };
}

/** Remove only a complete, plan/key/transaction-owned pair. Model caches remain. */
export async function cleanupDualSparkManagedVllm(
  plan: DualSparkVllmPlan,
  apiKey: string,
  deps: Pick<DualSparkVllmLifecycleDeps, "inspectNode" | "removeContainer" | "withLifecycleLock">,
  ownership?: DualSparkCleanupOwnership,
): Promise<CleanupDualSparkVllmResult> {
  let fingerprint: string;
  try {
    fingerprint = dualSparkVllmApiKeyFingerprint(apiKey);
  } catch (error) {
    return { ok: false, reason: (error as Error).message, removedContainerIds: [] };
  }
  try {
    return await deps.withLifecycleLock(plan, async () => {
      const snapshots = await inspectBoth(plan, deps);
      if (!snapshots) {
        return {
          ok: false,
          reason: "could not inspect both dual-Spark container daemons",
          removedContainerIds: [],
        };
      }
      const owned = ownership
        ? receiptOwnedTargetsForCleanup(plan, fingerprint, snapshots, ownership)
        : null;
      if (owned && !owned.ok) {
        return { ok: false, reason: owned.reason, removedContainerIds: [] };
      }
      const pair = ownership ? null : exactPairForCleanup(plan, fingerprint, snapshots);
      if (!ownership && !pair) {
        return {
          ok: false,
          reason: "dual-Spark cleanup requires one complete exact owned pair",
          removedContainerIds: [],
        };
      }
      const observations = owned?.ok ? owned.observations : [pair!.head, pair!.worker];
      const removedContainerIds: string[] = [];
      for (const observation of observations) {
        const removed = await deps.removeContainer(observation.rolePlan, observation.container.id);
        if (!removed.ok) {
          return {
            ok: false,
            reason: removed.reason ?? `${observation.rolePlan.role} cleanup failed`,
            removedContainerIds,
          };
        }
        removedContainerIds.push(observation.container.id);
      }
      return {
        ok: true,
        removedContainerIds,
        ...(owned?.ok && owned.alreadyAbsentContainerIds.length > 0
          ? { alreadyAbsentContainerIds: owned.alreadyAbsentContainerIds }
          : {}),
      };
    });
  } catch (error) {
    return {
      ok: false,
      reason: `dual-Spark cleanup failed: ${(error as Error).message}`,
      removedContainerIds: [],
    };
  }
}
