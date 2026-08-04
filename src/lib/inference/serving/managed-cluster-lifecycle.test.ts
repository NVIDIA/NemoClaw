// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureManagedClusterPlan } from "./managed-cluster-fixture.test-support.js";
import {
  classifyManagedClusterExistingState,
  cleanupManagedClusterManagedVllm,
  type ManagedClusterContainerStartRequest,
  type ManagedClusterNodeSnapshot,
  type ManagedClusterObservedContainer,
  type ManagedClusterVllmLifecycleDeps,
  managedClusterVllmApiKeyFingerprint,
  startAutomaticManagedClusterVllm,
} from "./managed-cluster-lifecycle.js";
import {
  MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL,
  MANAGED_CLUSTER_MANAGED_LABEL,
  MANAGED_CLUSTER_TRANSACTION_LABEL,
  type ManagedClusterVllmPlan,
  type ManagedClusterVllmRole,
  type ManagedClusterVllmRolePlan,
} from "./managed-cluster-materialize.js";

const API_KEY = "a".repeat(64);
const TRANSACTION_ID = "b".repeat(32);
const HEAD_ID = "1".repeat(64);
const WORKER_ID = "2".repeat(64);

type StoppedForeignContainerFixture = {
  readonly signal: string;
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
};

const STOPPED_FOREIGN_CONTAINER_FIXTURES: readonly StoppedForeignContainerFixture[] = [
  {
    signal: "name",
    name: "foreign-vllm-server",
    image: "example.invalid/inference:latest",
    labels: {},
  },
  {
    signal: "image",
    name: "foreign-inference",
    image: "vllm/vllm-openai:latest",
    labels: {},
  },
  {
    signal: "managed label",
    name: "foreign-inference",
    image: "example.invalid/inference:latest",
    labels: { [MANAGED_CLUSTER_MANAGED_LABEL]: "foreign" },
  },
];

type Harness = ReturnType<typeof createHarness>;

function managedContainer(
  plan: ManagedClusterVllmPlan,
  role: ManagedClusterVllmRole,
  overrides: Partial<ManagedClusterObservedContainer> = {},
): ManagedClusterObservedContainer {
  const rolePlan = plan.roles.find((candidate) => candidate.role === role)!;
  return {
    id: role === "head" ? HEAD_ID : WORKER_ID,
    name: rolePlan.containerName,
    image: rolePlan.image,
    running: true,
    healthy: true,
    labels: {
      ...rolePlan.baseLabels,
      [MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL]: managedClusterVllmApiKeyFingerprint(API_KEY),
      [MANAGED_CLUSTER_TRANSACTION_LABEL]: TRANSACTION_ID,
    },
    ...overrides,
  };
}

function classifiedSnapshots(
  plan: ManagedClusterVllmPlan,
  snapshots: Record<string, ManagedClusterNodeSnapshot>,
) {
  return plan.roles.map((rolePlan) => ({
    nodeId: rolePlan.nodeId,
    snapshot: snapshots[rolePlan.nodeId],
  }));
}

function createHarness(plan: ManagedClusterVllmPlan) {
  const events: string[] = [];
  const snapshots: Record<string, ManagedClusterNodeSnapshot> = Object.fromEntries(
    plan.roles.map(({ nodeId }) => [nodeId, { containers: [], listeningPorts: [] }]),
  );
  const inspectNode = vi.fn(async (rolePlan: ManagedClusterVllmRolePlan) => {
    events.push(`inspect:${rolePlan.role}`);
    return snapshots[rolePlan.nodeId];
  });
  const stageNode = vi.fn(async ({ rolePlan }: { rolePlan: ManagedClusterVllmRolePlan }) => {
    events.push(`stage:${rolePlan.role}`);
    return { ok: true };
  });
  const startContainer = vi.fn(async (request: ManagedClusterContainerStartRequest) => {
    const { rolePlan, labels } = request;
    events.push(`start:${rolePlan.role}`);
    const id = rolePlan.role === "head" ? HEAD_ID : WORKER_ID;
    snapshots[rolePlan.nodeId] = {
      ...snapshots[rolePlan.nodeId],
      containers: [
        {
          id,
          name: rolePlan.containerName,
          image: rolePlan.image,
          running: true,
          healthy: true,
          labels,
        },
      ],
    };
    return { ok: true, containerId: id };
  });
  const waitForContainerReady = vi.fn(async (request) => {
    events.push(`wait:${request.rolePlan.role}`);
    return true;
  });
  const waitForWorkerDistributedReady = vi.fn(async (request) => {
    events.push(`distributed:${request.rolePlan.role}`);
    return true;
  });
  const removeContainer = vi.fn(async (rolePlan: ManagedClusterVllmRolePlan, id: string) => {
    events.push(`remove:${rolePlan.role}:${id}`);
    snapshots[rolePlan.nodeId] = {
      ...snapshots[rolePlan.nodeId],
      containers: snapshots[rolePlan.nodeId]!.containers.filter((container) => container.id !== id),
    };
    return { ok: true };
  });
  const probeModels = vi.fn(async () => {
    events.push("probe:models");
    return true;
  });
  const probeChat = vi.fn(async () => {
    events.push("probe:chat");
    return true;
  });
  const deps: ManagedClusterVllmLifecycleDeps = {
    inspectNode,
    stageNode,
    startContainer,
    waitForContainerReady,
    waitForWorkerDistributedReady,
    removeContainer,
    probeModels,
    probeChat,
    createTransactionId: () => TRANSACTION_ID,
    withLifecycleLock: async (_plan, operation) => await operation(),
  };
  return {
    deps,
    events,
    snapshots,
    inspectNode,
    stageNode,
    startContainer,
    removeContainer,
    probeModels,
    probeChat,
  };
}

describe("automatic managed-cluster vLLM lifecycle", () => {
  let plan: ManagedClusterVllmPlan;
  let harness: Harness;

  beforeEach(() => {
    plan = fixtureManagedClusterPlan();
    harness = createHarness(plan);
  });

  it("inspects both nodes before staging either node", async () => {
    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result.ok).toBe(true);
    const firstStage = harness.events.findIndex((event) => event.startsWith("stage:"));
    expect(harness.events.slice(0, firstStage)).toEqual(
      expect.arrayContaining(["inspect:head", "inspect:worker"]),
    );
  });

  it("preserves singleton, Station, and related external setups", async () => {
    harness.snapshots[plan.roles[0].nodeId] = {
      containers: [
        {
          id: "9".repeat(64),
          name: "nemoclaw-vllm",
          image: "vllm/vllm-openai:latest",
          running: false,
          healthy: false,
          labels: { "com.nvidia.nemoclaw.managed-vllm": "true" },
        },
      ],
      listeningPorts: [],
    };

    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(harness.stageNode).not.toHaveBeenCalled();
    expect(harness.startContainer).not.toHaveBeenCalled();
    expect(harness.removeContainer).not.toHaveBeenCalled();
  });

  it.each(
    STOPPED_FOREIGN_CONTAINER_FIXTURES,
  )("preserves a stopped foreign vLLM setup identified by $signal", async (container) => {
    harness.snapshots[plan.roles[0].nodeId] = {
      containers: [
        {
          id: "9".repeat(64),
          name: container.name,
          image: container.image,
          running: false,
          healthy: false,
          labels: container.labels,
        },
      ],
      listeningPorts: [],
    };

    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(harness.stageNode).not.toHaveBeenCalled();
    expect(harness.startContainer).not.toHaveBeenCalled();
    expect(harness.removeContainer).not.toHaveBeenCalled();
  });

  it("does not classify an arbitrary stopped container as a managed vLLM setup", () => {
    const snapshots = {
      [plan.roles[0].nodeId]: {
        containers: [
          {
            id: "9".repeat(64),
            name: "unrelated-service",
            image: "example.invalid/worker:latest",
            running: false,
            healthy: false,
            labels: { "example.foreign": "true" },
          },
        ],
        listeningPorts: [],
      },
      [plan.roles[1].nodeId]: { containers: [], listeningPorts: [] },
    };

    expect(
      classifyManagedClusterExistingState(
        plan,
        managedClusterVllmApiKeyFingerprint(API_KEY),
        classifiedSnapshots(plan, snapshots),
      ),
    ).toEqual({ outcome: "clear" });
  });

  it("reuses only one exact healthy cluster with the same transaction", async () => {
    harness.snapshots[plan.roles[0].nodeId] = {
      containers: [managedContainer(plan, "head")],
      listeningPorts: [8000],
    };
    harness.snapshots[plan.roles[1].nodeId] = {
      containers: [managedContainer(plan, "worker")],
      listeningPorts: [25000],
    };

    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({
      ok: true,
      reusedExisting: true,
      containers: [
        { nodeId: plan.roles[0].nodeId, containerId: HEAD_ID },
        { nodeId: plan.roles[1].nodeId, containerId: WORKER_ID },
      ],
    });
    expect(harness.probeModels).toHaveBeenCalledOnce();
    expect(harness.probeChat).toHaveBeenCalledOnce();
    expect(harness.stageNode).not.toHaveBeenCalled();
    expect(harness.startContainer).not.toHaveBeenCalled();
  });

  it("does not implicitly repair a stopped or partial managed deployment", async () => {
    harness.snapshots[plan.roles[0].nodeId] = {
      containers: [managedContainer(plan, "head", { running: false, healthy: false })],
      listeningPorts: [],
    };
    harness.snapshots[plan.roles[1].nodeId] = {
      containers: [managedContainer(plan, "worker")],
      listeningPorts: [],
    };

    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(harness.startContainer).not.toHaveBeenCalled();
    expect(harness.removeContainer).not.toHaveBeenCalled();
  });

  it("starts and prepares rank 1 before rank 0 without exposing its API key", async () => {
    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result.ok).toBe(true);
    expect(harness.events.indexOf("start:worker")).toBeLessThan(
      harness.events.indexOf("distributed:worker"),
    );
    expect(harness.events.indexOf("distributed:worker")).toBeLessThan(
      harness.events.indexOf("start:head"),
    );
    const workerRequest = harness.startContainer.mock.calls[0]![0];
    const headRequest = harness.startContainer.mock.calls[1]![0];
    expect(workerRequest).not.toHaveProperty("bearerApiKey");
    expect(headRequest.bearerApiKey).toBe(API_KEY);
    expect(workerRequest.preparation.phase).toBe("container-before-exec");
    expect(headRequest.preparation.phase).toBe("container-before-exec");
    expect(JSON.stringify(workerRequest.labels)).not.toContain(API_KEY);
    expect(JSON.stringify(headRequest.labels)).not.toContain(API_KEY);
  });

  it("retains SSH ownership when a failed worker create leaves runtime state", async () => {
    harness.startContainer.mockImplementation(async ({ rolePlan, labels }) => {
      harness.snapshots[plan.roles[1].nodeId] = {
        containers: [
          {
            id: WORKER_ID,
            name: rolePlan.containerName,
            image: rolePlan.image,
            running: true,
            healthy: true,
            labels,
          },
        ],
        listeningPorts: [],
      };
      throw new Error("Docker create outcome was ambiguous");
    });

    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "start-failed" });
    const failed = result as Extract<typeof result, { ok: false }>;
    expect(failed.rollbackErrors).toContain(
      "managed cluster post-failure runtime state could not be proven clear; SSH ownership state was retained",
    );
    expect(harness.removeContainer).not.toHaveBeenCalled();
  });

  it("does not retain SSH ownership when a failed create is proven mutation-free", async () => {
    harness.startContainer.mockImplementation(async () => {
      throw new Error("Docker create failed before mutation");
    });

    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "start-failed",
      rollbackErrors: [],
    });
  });

  it("rolls back only exact transaction-created IDs after API failure", async () => {
    harness.probeChat.mockImplementation(async () => {
      harness.events.push("probe:chat");
      return false;
    });

    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({
      ok: false,
      code: "health-failed",
      rollbackErrors: [],
    });
    expect(harness.removeContainer.mock.calls.map((call) => call[1])).toEqual([HEAD_ID, WORKER_ID]);
    expect(harness.events).toContain("probe:models");
    expect(harness.events).toContain("probe:chat");
  });

  it("leaves a container untouched when transaction ownership changes before rollback", async () => {
    harness.probeChat.mockImplementation(async () => {
      const worker = harness.snapshots[plan.roles[1].nodeId]!.containers[0]!;
      harness.snapshots[plan.roles[1].nodeId] = {
        ...harness.snapshots[plan.roles[1].nodeId],
        containers: [
          {
            ...worker,
            labels: {
              ...worker.labels,
              [MANAGED_CLUSTER_TRANSACTION_LABEL]: "c".repeat(32),
            },
          },
        ],
      };
      return false;
    });

    const result = await startAutomaticManagedClusterVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "health-failed" });
    const failed = result as Extract<typeof result, { ok: false }>;
    expect(failed.rollbackErrors).toContain(
      "worker rollback ownership changed; container was left untouched",
    );
    expect(harness.removeContainer.mock.calls.map((call) => call[1])).toEqual([HEAD_ID]);
    expect(harness.snapshots[plan.roles[1].nodeId]!.containers).toHaveLength(1);
  });

  it("classifies port conflicts on either node as nonselectable", () => {
    expect(
      classifyManagedClusterExistingState(
        plan,
        managedClusterVllmApiKeyFingerprint(API_KEY),
        classifiedSnapshots(plan, {
          [plan.roles[0].nodeId]: { containers: [], listeningPorts: [] },
          [plan.roles[1].nodeId]: { containers: [], listeningPorts: [25000] },
        }),
      ),
    ).toEqual({
      outcome: "conflict",
      reason: `${plan.roles[1].nodeId} port 25000 is already in use`,
    });
  });

  it("cleans up only a complete exact cluster and retains all cache state", async () => {
    harness.snapshots[plan.roles[0].nodeId] = {
      containers: [managedContainer(plan, "head")],
      listeningPorts: [],
    };
    harness.snapshots[plan.roles[1].nodeId] = {
      containers: [managedContainer(plan, "worker")],
      listeningPorts: [],
    };

    const result = await cleanupManagedClusterManagedVllm(plan, API_KEY, harness.deps);

    expect(result).toEqual({
      ok: true,
      removedContainerIds: [HEAD_ID, WORKER_ID],
    });
    expect(harness.stageNode).not.toHaveBeenCalled();
  });

  it("retries cleanup after one receipt-owned container was already removed", async () => {
    harness.snapshots[plan.roles[0].nodeId] = {
      containers: [managedContainer(plan, "head")],
      listeningPorts: [],
    };
    harness.snapshots[plan.roles[1].nodeId] = {
      containers: [managedContainer(plan, "worker")],
      listeningPorts: [],
    };
    let workerAttempts = 0;
    harness.removeContainer.mockImplementation(async (rolePlan, id) => {
      const shouldFailWorker = rolePlan.role === "worker" && workerAttempts === 0;
      workerAttempts += Number(rolePlan.role === "worker");
      const removeOwnedContainer = () => {
        harness.snapshots[rolePlan.nodeId] = {
          ...harness.snapshots[rolePlan.nodeId],
          containers: harness.snapshots[rolePlan.nodeId]!.containers.filter(
            (container) => container.id !== id,
          ),
        };
        return { ok: true } as const;
      };
      return shouldFailWorker
        ? ({ ok: false, reason: "worker daemon unavailable" } as const)
        : removeOwnedContainer();
    });
    const ownership = {
      containers: [
        { nodeId: plan.roles[0].nodeId, containerId: HEAD_ID },
        { nodeId: plan.roles[1].nodeId, containerId: WORKER_ID },
      ],
    };

    await expect(
      cleanupManagedClusterManagedVllm(plan, API_KEY, harness.deps, ownership),
    ).resolves.toEqual({
      ok: false,
      reason: "worker daemon unavailable",
      removedContainerIds: [HEAD_ID],
    });
    await expect(
      cleanupManagedClusterManagedVllm(plan, API_KEY, harness.deps, ownership),
    ).resolves.toEqual({
      ok: true,
      removedContainerIds: [WORKER_ID],
      alreadyAbsentContainerIds: [HEAD_ID],
    });
  });
});
