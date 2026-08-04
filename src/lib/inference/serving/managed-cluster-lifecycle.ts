// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";

import {
  MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL,
  MANAGED_CLUSTER_MANAGED_LABEL,
  MANAGED_CLUSTER_TRANSACTION_LABEL,
  MANAGED_CLUSTER_VLLM_PROJECT_ID,
  type ManagedClusterVllmPlan,
  type ManagedClusterVllmRolePlan,
  managedClusterHeadRole,
} from "./managed-cluster-materialize.js";

const API_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/;
const FINGERPRINT_CONTEXT = "nemoclaw-managed-cluster-vllm-api-key\0";
const STATION_CONTAINER_NAMES = new Set(["nemoclaw-vllm", "nemoclaw-vllm-worker"]);
const STATION_LABEL_PREFIX = "com.nvidia.nemoclaw.vllm-";
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const VLLM_TOKEN_PATTERN = /(?:^|[./:_-])vllm(?:$|[./:@_-])/i;

export interface ManagedClusterObservedContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly running: boolean;
  /** True only after the executor's bounded role-specific readiness check. */
  readonly healthy: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ManagedClusterNodeSnapshot {
  /** All containers visible to the node daemon, including stopped containers. */
  readonly containers: readonly ManagedClusterObservedContainer[];
  /** Host-network listeners. The executor must inspect all requested ports. */
  readonly listeningPorts: readonly number[];
}

export type ManagedClusterExistingState =
  | { readonly outcome: "clear" }
  | {
      readonly outcome: "reuse";
      readonly containers: readonly ManagedClusterOwnedContainer[];
      readonly transactionId: string;
    }
  | { readonly outcome: "conflict"; readonly reason: string }
  | { readonly outcome: "unknown"; readonly reason: string };

export interface ManagedClusterStageRequest {
  readonly rolePlan: ManagedClusterVllmRolePlan;
  /** Verify or fetch only the pinned model snapshot and immutable image. */
  readonly preparation: ManagedClusterVllmRolePlan["preparation"];
}

export interface ManagedClusterContainerStartRequest {
  readonly rolePlan: ManagedClusterVllmRolePlan;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The executor performs this code-owned preparation inside the newly
   * created container, then directly execs the role command. Copy/replace
   * operations must match exactly or creation fails before vLLM starts.
   */
  readonly preparation: ManagedClusterVllmRolePlan["preparation"];
  /** Present only for the head. The executor must not persist it in labels or the plan. */
  readonly bearerApiKey?: string;
}

export interface ManagedClusterContainerStartResult {
  readonly ok: boolean;
  readonly containerId?: string;
  readonly reason?: string;
}

export interface ManagedClusterContainerWaitRequest {
  readonly rolePlan: ManagedClusterVllmRolePlan;
  readonly containerId: string;
  readonly expectedLabels: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface ManagedClusterApiProbeRequest {
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
export interface ManagedClusterVllmLifecycleDeps {
  inspectNode(rolePlan: ManagedClusterVllmRolePlan): Promise<ManagedClusterNodeSnapshot>;
  stageNode(request: ManagedClusterStageRequest): Promise<{ ok: boolean; reason?: string }>;
  startContainer(
    request: ManagedClusterContainerStartRequest,
  ): Promise<ManagedClusterContainerStartResult>;
  waitForContainerReady(request: ManagedClusterContainerWaitRequest): Promise<boolean>;
  /** Prove a worker process is alive and waiting at the distributed rendezvous. */
  waitForWorkerDistributedReady(request: ManagedClusterContainerWaitRequest): Promise<boolean>;
  removeContainer(
    rolePlan: ManagedClusterVllmRolePlan,
    exactContainerId: string,
  ): Promise<{ ok: boolean; reason?: string }>;
  probeModels(request: ManagedClusterApiProbeRequest): Promise<boolean>;
  probeChat(request: ManagedClusterApiProbeRequest): Promise<boolean>;
  createTransactionId(): string;
  withLifecycleLock<T>(plan: ManagedClusterVllmPlan, operation: () => Promise<T>): Promise<T>;
}

export interface ManagedClusterRuntimeInspection {
  readonly state: ManagedClusterExistingState;
  readonly snapshots?: readonly ManagedClusterRoleSnapshot[];
}

export type CleanupManagedClusterVllmResult =
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

export interface ManagedClusterCleanupOwnership {
  readonly containers: readonly ManagedClusterOwnedContainer[];
}

export interface ManagedClusterOwnedContainer {
  readonly nodeId: string;
  readonly containerId: string;
}

export interface ManagedClusterRoleSnapshot {
  readonly nodeId: string;
  readonly snapshot: ManagedClusterNodeSnapshot;
}

export type StartManagedClusterVllmResult =
  | {
      readonly ok: true;
      readonly reusedExisting: boolean;
      readonly baseUrl: string;
      readonly containers: readonly ManagedClusterOwnedContainer[];
      readonly apiKeyFingerprint: string;
    }
  | {
      readonly ok: false;
      readonly code: "conflict" | "unknown" | "staging-failed" | "start-failed" | "health-failed";
      readonly reason: string;
      readonly rollbackErrors: readonly string[];
    };

interface RoleObservation {
  rolePlan: ManagedClusterVllmRolePlan;
  container: ManagedClusterObservedContainer;
  expectedLabels: Readonly<Record<string, string>>;
}

interface CreatedContainer {
  rolePlan: ManagedClusterVllmRolePlan;
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
  snapshot: ManagedClusterNodeSnapshot,
  rolePlan: ManagedClusterVllmRolePlan,
  apiKeyFingerprint: string,
): RoleObservation | null {
  const matches = snapshot.containers.filter(({ name }) => name === rolePlan.containerName);
  if (matches.length !== 1) return null;
  const container = matches[0]!;
  const transactionId = container.labels[MANAGED_CLUSTER_TRANSACTION_LABEL] ?? "";
  const expectedLabels = {
    ...rolePlan.baseLabels,
    [MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL]: apiKeyFingerprint,
    [MANAGED_CLUSTER_TRANSACTION_LABEL]: transactionId,
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
export function isRelatedManagedVllmContainer(container: ManagedClusterObservedContainer): boolean {
  if (STATION_CONTAINER_NAMES.has(container.name)) return true;
  if (VLLM_TOKEN_PATTERN.test(container.name) || VLLM_TOKEN_PATTERN.test(container.image)) {
    return true;
  }
  if (Object.hasOwn(container.labels, MANAGED_CLUSTER_MANAGED_LABEL)) return true;
  if (container.labels[COMPOSE_PROJECT_LABEL] === MANAGED_CLUSTER_VLLM_PROJECT_ID) return true;
  if (container.labels[COMPOSE_SERVICE_LABEL] === "vllm-cluster") return true;
  return Object.keys(container.labels).some((key) => key.startsWith(STATION_LABEL_PREFIX));
}

function invalidSnapshotReason(snapshot: ManagedClusterNodeSnapshot, node: string): string | null {
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
export function classifyManagedClusterExistingState(
  plan: ManagedClusterVllmPlan,
  apiKeyFingerprint: string,
  snapshots: readonly ManagedClusterRoleSnapshot[],
): ManagedClusterExistingState {
  if (!/^[a-f0-9]{64}$/.test(apiKeyFingerprint)) {
    return { outcome: "unknown", reason: "managed cluster API key fingerprint is invalid" };
  }
  if (
    snapshots.length !== plan.roles.length ||
    new Set(snapshots.map(({ nodeId }) => nodeId)).size !== snapshots.length ||
    snapshots.some(({ nodeId }) => !plan.roles.some((role) => role.nodeId === nodeId))
  ) {
    return { outcome: "unknown", reason: "managed cluster node inspection is incomplete" };
  }
  for (const { nodeId, snapshot } of snapshots) {
    const invalid = invalidSnapshotReason(snapshot, nodeId);
    if (invalid) return { outcome: "unknown", reason: invalid };
  }

  const observations = plan.roles.map((rolePlan) => {
    const snapshot = snapshots.find(({ nodeId }) => nodeId === rolePlan.nodeId)!.snapshot;
    return exactRoleObservation(snapshot, rolePlan, apiKeyFingerprint);
  });
  const allContainers = snapshots.flatMap(({ snapshot }) => snapshot.containers);
  const exactIds = new Set(observations.flatMap((entry) => (entry ? [entry.container.id] : [])));
  const unexpectedRelated = allContainers.find(
    (container) => isRelatedManagedVllmContainer(container) && !exactIds.has(container.id),
  );
  if (unexpectedRelated) {
    return {
      outcome: "conflict",
      reason: `existing related container ${unexpectedRelated.name} is not part of the exact managed cluster`,
    };
  }

  if (observations.some(Boolean)) {
    if (observations.some((observation) => !observation)) {
      return { outcome: "conflict", reason: "managed cluster deployment is incomplete" };
    }
    const exact = observations as RoleObservation[];
    const transactions = new Set(
      exact.map(({ container }) => container.labels[MANAGED_CLUSTER_TRANSACTION_LABEL]),
    );
    if (transactions.size !== 1) {
      return { outcome: "conflict", reason: "managed cluster transaction labels do not match" };
    }
    if (exact.some(({ container }) => !container.running || !container.healthy)) {
      return {
        outcome: "conflict",
        reason: "managed cluster deployment is stopped, incomplete, or unhealthy",
      };
    }
    return {
      outcome: "reuse",
      containers: exact.map(({ rolePlan, container }) => ({
        nodeId: rolePlan.nodeId,
        containerId: container.id,
      })),
      transactionId: exact[0]!.container.labels[MANAGED_CLUSTER_TRANSACTION_LABEL]!,
    };
  }

  const dedicatedNames = new Set(plan.roles.map(({ containerName }) => containerName));
  const dedicatedNameExists = allContainers.some(({ name }) => dedicatedNames.has(name));
  if (dedicatedNameExists) {
    return { outcome: "conflict", reason: "managed cluster container name ownership is foreign" };
  }
  for (const { nodeId, snapshot } of snapshots) {
    const occupied = snapshot.listeningPorts.find(
      (port) => port === plan.apiPort || port === plan.masterPort,
    );
    if (occupied !== undefined) {
      return {
        outcome: "conflict",
        reason: `${nodeId} port ${String(occupied)} is already in use`,
      };
    }
  }
  return { outcome: "clear" };
}

/** Domain-separated non-secret ownership binding for the managed endpoint key. */
export function managedClusterVllmApiKeyFingerprint(apiKey: string): string {
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error("Managed cluster vLLM API key must be 64 lowercase hexadecimal characters.");
  }
  return createHmac("sha256", Buffer.from(apiKey, "hex")).update(FINGERPRINT_CONTEXT).digest("hex");
}

async function inspectAll(
  plan: ManagedClusterVllmPlan,
  deps: Pick<ManagedClusterVllmLifecycleDeps, "inspectNode">,
): Promise<readonly ManagedClusterRoleSnapshot[] | null> {
  try {
    return await Promise.all(
      plan.roles.map(async (rolePlan) => ({
        nodeId: rolePlan.nodeId,
        snapshot: await deps.inspectNode(rolePlan),
      })),
    );
  } catch {
    return null;
  }
}

/** Inspect every daemon before any image, cache, or container mutation. */
export async function preflightManagedClusterVllm(
  plan: ManagedClusterVllmPlan,
  apiKey: string,
  deps: Pick<ManagedClusterVllmLifecycleDeps, "inspectNode">,
): Promise<ManagedClusterExistingState> {
  let fingerprint: string;
  try {
    fingerprint = managedClusterVllmApiKeyFingerprint(apiKey);
  } catch (error) {
    return { outcome: "unknown", reason: (error as Error).message };
  }
  const snapshots = await inspectAll(plan, deps);
  return snapshots
    ? classifyManagedClusterExistingState(plan, fingerprint, snapshots)
    : { outcome: "unknown", reason: "could not inspect every managed cluster container daemon" };
}

/** Plan- and key-specific read-only inspection for installer/runtime recovery. */
export async function inspectManagedClusterManagedRuntime(
  plan: ManagedClusterVllmPlan,
  apiKey: string,
  deps: Pick<ManagedClusterVllmLifecycleDeps, "inspectNode">,
): Promise<ManagedClusterRuntimeInspection> {
  let fingerprint: string;
  try {
    fingerprint = managedClusterVllmApiKeyFingerprint(apiKey);
  } catch (error) {
    return { state: { outcome: "unknown", reason: (error as Error).message } };
  }
  const snapshots = await inspectAll(plan, deps);
  return snapshots
    ? { state: classifyManagedClusterExistingState(plan, fingerprint, snapshots), snapshots }
    : {
        state: {
          outcome: "unknown",
          reason: "could not inspect every managed cluster container daemon",
        },
      };
}

function labelsForStart(
  rolePlan: ManagedClusterVllmRolePlan,
  apiKeyFingerprint: string,
  transactionId: string,
): Readonly<Record<string, string>> {
  return {
    ...rolePlan.baseLabels,
    [MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL]: apiKeyFingerprint,
    [MANAGED_CLUSTER_TRANSACTION_LABEL]: transactionId,
  };
}

function exactCreatedContainer(
  snapshot: ManagedClusterNodeSnapshot,
  created: CreatedContainer,
): ManagedClusterObservedContainer | null {
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
  deps: ManagedClusterVllmLifecycleDeps,
): Promise<string[]> {
  const errors: string[] = [];
  for (const item of [...created].reverse()) {
    let snapshot: ManagedClusterNodeSnapshot;
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
  plan: ManagedClusterVllmPlan,
  apiKeyFingerprint: string,
  created: readonly CreatedContainer[],
  deps: ManagedClusterVllmLifecycleDeps,
): Promise<string[]> {
  const rollbackErrors = await rollbackCreated(created, deps);
  const snapshots = await inspectAll(plan, deps);
  if (
    snapshots &&
    classifyManagedClusterExistingState(plan, apiKeyFingerprint, snapshots).outcome === "clear"
  ) {
    return [];
  }
  return [
    ...rollbackErrors,
    "managed cluster post-failure runtime state could not be proven clear; SSH ownership state was retained",
  ];
}

async function startRole(
  rolePlan: ManagedClusterVllmRolePlan,
  apiKey: string,
  apiKeyFingerprint: string,
  transactionId: string,
  timeoutMs: number,
  deps: ManagedClusterVllmLifecycleDeps,
): Promise<
  | { ok: true; created: CreatedContainer }
  | { ok: false; reason: string; created?: CreatedContainer }
> {
  const expectedLabels = labelsForStart(rolePlan, apiKeyFingerprint, transactionId);
  let started: ManagedClusterContainerStartResult;
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

  let snapshot: ManagedClusterNodeSnapshot;
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
  code: Extract<StartManagedClusterVllmResult, { ok: false }>["code"],
  reason: string,
  rollbackErrors: readonly string[] = [],
): StartManagedClusterVllmResult {
  return { ok: false, code, reason, rollbackErrors };
}

async function probeManagedApi(
  plan: ManagedClusterVllmPlan,
  apiKey: string,
  deps: Pick<ManagedClusterVllmLifecycleDeps, "probeModels" | "probeChat">,
): Promise<boolean> {
  const baseUrl = managedClusterHeadRole(plan).endpoint;
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

async function startNewCluster(
  plan: ManagedClusterVllmPlan,
  apiKey: string,
  apiKeyFingerprint: string,
  deps: ManagedClusterVllmLifecycleDeps,
): Promise<StartManagedClusterVllmResult> {
  const staged = await Promise.all(
    [...plan.roles]
      .sort((left, right) => right.rank - left.rank)
      .map(async (rolePlan) => {
        try {
          return await deps.stageNode({ rolePlan, preparation: rolePlan.preparation });
        } catch {
          return { ok: false, reason: `${rolePlan.role} staging failed` };
        }
      }),
  );
  const failedStage = staged.find((result) => !result.ok);
  if (failedStage) {
    return failure("staging-failed", failedStage.reason ?? "managed cluster staging failed");
  }

  const afterStageSnapshots = await inspectAll(plan, deps);
  if (!afterStageSnapshots) {
    return failure("unknown", "could not re-inspect every daemon after staging");
  }
  const afterStage = classifyManagedClusterExistingState(
    plan,
    apiKeyFingerprint,
    afterStageSnapshots,
  );
  if (afterStage.outcome !== "clear") {
    return failure(
      afterStage.outcome === "unknown" ? "unknown" : "conflict",
      `managed cluster ownership changed during staging: ${
        "reason" in afterStage ? afterStage.reason : afterStage.outcome
      }`,
    );
  }

  const transactionId = deps.createTransactionId();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    return failure("unknown", "managed cluster lifecycle transaction ID is invalid");
  }

  const created: CreatedContainer[] = [];
  for (const rolePlan of [...plan.roles].sort((left, right) => right.rank - left.rank)) {
    const result = await startRole(
      rolePlan,
      apiKey,
      apiKeyFingerprint,
      transactionId,
      plan.readiness.timeoutMs,
      deps,
    );
    if (!result.ok) {
      if (result.created) created.push(result.created);
      return failure(
        "start-failed",
        result.reason,
        await rollbackCreatedAndProveClear(plan, apiKeyFingerprint, created, deps),
      );
    }
    created.push(result.created);
  }

  if (!(await probeManagedApi(plan, apiKey, deps))) {
    return failure(
      "health-failed",
      "managed cluster models or chat health check failed",
      await rollbackCreatedAndProveClear(plan, apiKeyFingerprint, created, deps),
    );
  }

  const finalSnapshots = await inspectAll(plan, deps);
  const finalState = finalSnapshots
    ? classifyManagedClusterExistingState(plan, apiKeyFingerprint, finalSnapshots)
    : null;
  if (
    !finalState ||
    finalState.outcome !== "reuse" ||
    finalState.transactionId !== transactionId ||
    finalState.containers.length !== created.length ||
    created.some(
      ({ rolePlan, containerId }) =>
        !finalState.containers.some(
          (owned) => owned.nodeId === rolePlan.nodeId && owned.containerId === containerId,
        ),
    )
  ) {
    return failure(
      "health-failed",
      "managed cluster ownership changed before lifecycle commit",
      await rollbackCreatedAndProveClear(plan, apiKeyFingerprint, created, deps),
    );
  }
  return {
    ok: true,
    reusedExisting: false,
    baseUrl: managedClusterHeadRole(plan).endpoint!,
    containers: created.map(({ rolePlan, containerId }) => ({
      nodeId: rolePlan.nodeId,
      containerId,
    })),
    apiKeyFingerprint,
  };
}

/**
 * Automatic lifecycle: exact healthy reuse or clean worker-first creation.
 * Stopped, partial, mismatched, Station, singleton, and foreign deployments
 * are never repaired or replaced.
 */
export async function startAutomaticManagedClusterVllm(
  plan: ManagedClusterVllmPlan,
  apiKey: string,
  deps: ManagedClusterVllmLifecycleDeps,
): Promise<StartManagedClusterVllmResult> {
  let apiKeyFingerprint: string;
  try {
    apiKeyFingerprint = managedClusterVllmApiKeyFingerprint(apiKey);
  } catch (error) {
    return failure("unknown", (error as Error).message);
  }

  try {
    return await deps.withLifecycleLock(plan, async () => {
      const preflight = await preflightManagedClusterVllm(plan, apiKey, deps);
      if (preflight.outcome === "unknown" || preflight.outcome === "conflict") {
        return failure(preflight.outcome, preflight.reason);
      }
      if (preflight.outcome === "reuse") {
        if (!(await probeManagedApi(plan, apiKey, deps))) {
          return failure(
            "conflict",
            "existing managed cluster API is unhealthy; no repair attempted",
          );
        }
        return {
          ok: true,
          reusedExisting: true,
          baseUrl: managedClusterHeadRole(plan).endpoint!,
          containers: preflight.containers,
          apiKeyFingerprint,
        };
      }
      return await startNewCluster(plan, apiKey, apiKeyFingerprint, deps);
    });
  } catch (error) {
    return failure("unknown", `managed cluster lifecycle failed: ${(error as Error).message}`);
  }
}

function exactClusterForCleanup(
  plan: ManagedClusterVllmPlan,
  apiKeyFingerprint: string,
  snapshots: readonly ManagedClusterRoleSnapshot[],
): readonly RoleObservation[] | null {
  const observations = plan.roles.map((rolePlan) => {
    const snapshot = snapshots.find(({ nodeId }) => nodeId === rolePlan.nodeId)?.snapshot;
    return snapshot ? exactRoleObservation(snapshot, rolePlan, apiKeyFingerprint) : null;
  });
  if (observations.some((observation) => !observation)) return null;
  const exact = observations as RoleObservation[];
  const transactions = new Set(
    exact.map(({ container }) => container.labels[MANAGED_CLUSTER_TRANSACTION_LABEL]),
  );
  if (transactions.size !== 1 || !exact[0]?.container.labels[MANAGED_CLUSTER_TRANSACTION_LABEL]) {
    return null;
  }
  const exactIds = new Set(exact.map(({ container }) => container.id));
  const related = snapshots
    .flatMap(({ snapshot }) => snapshot.containers)
    .find((container) => isRelatedManagedVllmContainer(container) && !exactIds.has(container.id));
  return related ? null : exact;
}

function receiptOwnedTargetsForCleanup(
  plan: ManagedClusterVllmPlan,
  apiKeyFingerprint: string,
  snapshots: readonly ManagedClusterRoleSnapshot[],
  ownership: ManagedClusterCleanupOwnership,
):
  | {
      readonly ok: true;
      readonly observations: readonly RoleObservation[];
      readonly alreadyAbsentContainerIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string } {
  const expectedIds = ownership.containers.map(({ containerId }) => containerId);
  if (
    ownership.containers.length !== plan.roles.length ||
    expectedIds.some((id) => !CONTAINER_ID_PATTERN.test(id)) ||
    new Set(expectedIds).size !== expectedIds.length ||
    new Set(ownership.containers.map(({ nodeId }) => nodeId)).size !==
      ownership.containers.length ||
    ownership.containers.some(({ nodeId }) => !plan.roles.some((role) => role.nodeId === nodeId))
  ) {
    return { ok: false, reason: "managed cluster cleanup receipt identities are invalid" };
  }

  const observations: RoleObservation[] = [];
  const alreadyAbsentContainerIds: string[] = [];
  let transactionId: string | null = null;
  for (const rolePlan of plan.roles) {
    const snapshot = snapshots.find(({ nodeId }) => nodeId === rolePlan.nodeId)?.snapshot;
    const expectedId = ownership.containers.find(
      ({ nodeId }) => nodeId === rolePlan.nodeId,
    )?.containerId;
    if (!snapshot || !expectedId) {
      return { ok: false, reason: "managed cluster cleanup receipt is incomplete" };
    }
    const invalid = invalidSnapshotReason(snapshot, rolePlan.nodeId);
    if (invalid) return { ok: false, reason: invalid };
    const related = snapshot.containers.filter(isRelatedManagedVllmContainer);
    const expected = snapshot.containers.find(({ id }) => id === expectedId);
    if (!expected) {
      if (related.length > 0) {
        return {
          ok: false,
          reason: `${rolePlan.nodeId} receipt-owned container is absent but related runtime state exists`,
        };
      }
      alreadyAbsentContainerIds.push(expectedId);
      continue;
    }
    const observation = exactRoleObservation(snapshot, rolePlan, apiKeyFingerprint);
    if (
      !observation ||
      observation.container.id !== expectedId ||
      related.some(({ id }) => id !== expectedId)
    ) {
      return { ok: false, reason: `${rolePlan.nodeId} receipt-owned container identity changed` };
    }
    const observedTransaction = observation.container.labels[MANAGED_CLUSTER_TRANSACTION_LABEL]!;
    if (transactionId !== null && transactionId !== observedTransaction) {
      return { ok: false, reason: "managed cluster receipt-owned transaction identity changed" };
    }
    transactionId = observedTransaction;
    observations.push(observation);
  }
  return { ok: true, observations, alreadyAbsentContainerIds };
}

/** Remove only a complete, plan/key/transaction-owned cluster. Model caches remain. */
export async function cleanupManagedClusterManagedVllm(
  plan: ManagedClusterVllmPlan,
  apiKey: string,
  deps: Pick<
    ManagedClusterVllmLifecycleDeps,
    "inspectNode" | "removeContainer" | "withLifecycleLock"
  >,
  ownership?: ManagedClusterCleanupOwnership,
): Promise<CleanupManagedClusterVllmResult> {
  let fingerprint: string;
  try {
    fingerprint = managedClusterVllmApiKeyFingerprint(apiKey);
  } catch (error) {
    return { ok: false, reason: (error as Error).message, removedContainerIds: [] };
  }
  try {
    return await deps.withLifecycleLock(plan, async () => {
      const snapshots = await inspectAll(plan, deps);
      if (!snapshots) {
        return {
          ok: false,
          reason: "could not inspect every managed cluster container daemon",
          removedContainerIds: [],
        };
      }
      const owned = ownership
        ? receiptOwnedTargetsForCleanup(plan, fingerprint, snapshots, ownership)
        : null;
      if (owned && !owned.ok) {
        return { ok: false, reason: owned.reason, removedContainerIds: [] };
      }
      const cluster = ownership ? null : exactClusterForCleanup(plan, fingerprint, snapshots);
      if (!ownership && !cluster) {
        return {
          ok: false,
          reason: "managed cluster cleanup requires one complete exact owned cluster",
          removedContainerIds: [],
        };
      }
      const observations = owned?.ok ? owned.observations : cluster!;
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
      reason: `managed cluster cleanup failed: ${(error as Error).message}`,
      removedContainerIds: [],
    };
  }
}
