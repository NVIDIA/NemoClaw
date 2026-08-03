// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureDualSparkPlan } from "./dual-spark-fixture.test-support.js";
import {
  classifyDualSparkExistingState,
  cleanupDualSparkManagedVllm,
  type DualSparkContainerStartRequest,
  type DualSparkNodeSnapshot,
  type DualSparkObservedContainer,
  type DualSparkVllmLifecycleDeps,
  dualSparkVllmApiKeyFingerprint,
  startAutomaticDualSparkVllm,
} from "./dual-spark-lifecycle.js";
import {
  DUAL_SPARK_API_KEY_FINGERPRINT_LABEL,
  DUAL_SPARK_MANAGED_LABEL,
  DUAL_SPARK_TRANSACTION_LABEL,
  type DualSparkVllmPlan,
  type DualSparkVllmRole,
  type DualSparkVllmRolePlan,
} from "./dual-spark-materialize.js";

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
    labels: { [DUAL_SPARK_MANAGED_LABEL]: "foreign" },
  },
];

type Harness = ReturnType<typeof createHarness>;

function managedContainer(
  plan: DualSparkVllmPlan,
  role: DualSparkVllmRole,
  overrides: Partial<DualSparkObservedContainer> = {},
): DualSparkObservedContainer {
  const rolePlan = plan.roles[role];
  return {
    id: role === "head" ? HEAD_ID : WORKER_ID,
    name: rolePlan.containerName,
    image: rolePlan.image,
    running: true,
    healthy: true,
    labels: {
      ...rolePlan.baseLabels,
      [DUAL_SPARK_API_KEY_FINGERPRINT_LABEL]: dualSparkVllmApiKeyFingerprint(API_KEY),
      [DUAL_SPARK_TRANSACTION_LABEL]: TRANSACTION_ID,
    },
    ...overrides,
  };
}

function createHarness(plan: DualSparkVllmPlan) {
  const events: string[] = [];
  const snapshots: Record<DualSparkVllmRole, DualSparkNodeSnapshot> = {
    head: { containers: [], listeningPorts: [] },
    worker: { containers: [], listeningPorts: [] },
  };
  const inspectNode = vi.fn(async (rolePlan: DualSparkVllmRolePlan) => {
    events.push(`inspect:${rolePlan.role}`);
    return snapshots[rolePlan.role];
  });
  const stageNode = vi.fn(async ({ rolePlan }: { rolePlan: DualSparkVllmRolePlan }) => {
    events.push(`stage:${rolePlan.role}`);
    return { ok: true };
  });
  const startContainer = vi.fn(async (request: DualSparkContainerStartRequest) => {
    const { rolePlan, labels } = request;
    events.push(`start:${rolePlan.role}`);
    const id = rolePlan.role === "head" ? HEAD_ID : WORKER_ID;
    snapshots[rolePlan.role] = {
      ...snapshots[rolePlan.role],
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
  const removeContainer = vi.fn(async (rolePlan: DualSparkVllmRolePlan, id: string) => {
    events.push(`remove:${rolePlan.role}:${id}`);
    snapshots[rolePlan.role] = {
      ...snapshots[rolePlan.role],
      containers: snapshots[rolePlan.role].containers.filter((container) => container.id !== id),
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
  const deps: DualSparkVllmLifecycleDeps = {
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

describe("automatic dual-DGX-Spark vLLM lifecycle", () => {
  let plan: DualSparkVllmPlan;
  let harness: Harness;

  beforeEach(() => {
    plan = fixtureDualSparkPlan();
    harness = createHarness(plan);
  });

  it("inspects both nodes before staging either node", async () => {
    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

    expect(result.ok).toBe(true);
    const firstStage = harness.events.findIndex((event) => event.startsWith("stage:"));
    expect(harness.events.slice(0, firstStage)).toEqual(
      expect.arrayContaining(["inspect:head", "inspect:worker"]),
    );
  });

  it("preserves singleton, Station, and related external setups", async () => {
    harness.snapshots.head = {
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

    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(harness.stageNode).not.toHaveBeenCalled();
    expect(harness.startContainer).not.toHaveBeenCalled();
    expect(harness.removeContainer).not.toHaveBeenCalled();
  });

  it.each(
    STOPPED_FOREIGN_CONTAINER_FIXTURES,
  )("preserves a stopped foreign vLLM setup identified by $signal", async (container) => {
    harness.snapshots.head = {
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

    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(harness.stageNode).not.toHaveBeenCalled();
    expect(harness.startContainer).not.toHaveBeenCalled();
    expect(harness.removeContainer).not.toHaveBeenCalled();
  });

  it("does not classify an arbitrary stopped container as a managed vLLM setup", () => {
    const snapshots = {
      head: {
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
      worker: { containers: [], listeningPorts: [] },
    };

    expect(
      classifyDualSparkExistingState(plan, dualSparkVllmApiKeyFingerprint(API_KEY), snapshots),
    ).toEqual({ outcome: "clear" });
  });

  it("reuses only one exact healthy pair with the same transaction", async () => {
    harness.snapshots.head = {
      containers: [managedContainer(plan, "head")],
      listeningPorts: [8000],
    };
    harness.snapshots.worker = {
      containers: [managedContainer(plan, "worker")],
      listeningPorts: [25000],
    };

    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({
      ok: true,
      reusedExisting: true,
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
    });
    expect(harness.probeModels).toHaveBeenCalledOnce();
    expect(harness.probeChat).toHaveBeenCalledOnce();
    expect(harness.stageNode).not.toHaveBeenCalled();
    expect(harness.startContainer).not.toHaveBeenCalled();
  });

  it("does not implicitly repair a stopped or partial managed deployment", async () => {
    harness.snapshots.head = {
      containers: [managedContainer(plan, "head", { running: false, healthy: false })],
      listeningPorts: [],
    };
    harness.snapshots.worker = {
      containers: [managedContainer(plan, "worker")],
      listeningPorts: [],
    };

    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(harness.startContainer).not.toHaveBeenCalled();
    expect(harness.removeContainer).not.toHaveBeenCalled();
  });

  it("starts and prepares rank 1 before rank 0 without exposing its API key", async () => {
    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

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
      harness.snapshots.worker = {
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

    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "start-failed" });
    const failed = result as Extract<typeof result, { ok: false }>;
    expect(failed.rollbackErrors).toContain(
      "dual-Spark post-failure runtime state could not be proven clear; SSH ownership state was retained",
    );
    expect(harness.removeContainer).not.toHaveBeenCalled();
  });

  it("does not retain SSH ownership when a failed create is proven mutation-free", async () => {
    harness.startContainer.mockImplementation(async () => {
      throw new Error("Docker create failed before mutation");
    });

    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

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

    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

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
      const worker = harness.snapshots.worker.containers[0]!;
      harness.snapshots.worker = {
        ...harness.snapshots.worker,
        containers: [
          {
            ...worker,
            labels: {
              ...worker.labels,
              [DUAL_SPARK_TRANSACTION_LABEL]: "c".repeat(32),
            },
          },
        ],
      };
      return false;
    });

    const result = await startAutomaticDualSparkVllm(plan, API_KEY, harness.deps);

    expect(result).toMatchObject({ ok: false, code: "health-failed" });
    const failed = result as Extract<typeof result, { ok: false }>;
    expect(failed.rollbackErrors).toContain(
      "worker rollback ownership changed; container was left untouched",
    );
    expect(harness.removeContainer.mock.calls.map((call) => call[1])).toEqual([HEAD_ID]);
    expect(harness.snapshots.worker.containers).toHaveLength(1);
  });

  it("classifies port conflicts on either node as nonselectable", () => {
    expect(
      classifyDualSparkExistingState(plan, dualSparkVllmApiKeyFingerprint(API_KEY), {
        head: { containers: [], listeningPorts: [] },
        worker: { containers: [], listeningPorts: [25000] },
      }),
    ).toEqual({
      outcome: "conflict",
      reason: "worker port 25000 is already in use",
    });
  });

  it("cleans up only a complete exact pair and retains all cache state", async () => {
    harness.snapshots.head = {
      containers: [managedContainer(plan, "head")],
      listeningPorts: [],
    };
    harness.snapshots.worker = {
      containers: [managedContainer(plan, "worker")],
      listeningPorts: [],
    };

    const result = await cleanupDualSparkManagedVllm(plan, API_KEY, harness.deps);

    expect(result).toEqual({
      ok: true,
      removedContainerIds: [HEAD_ID, WORKER_ID],
    });
    expect(harness.stageNode).not.toHaveBeenCalled();
  });

  it("retries cleanup after one receipt-owned container was already removed", async () => {
    harness.snapshots.head = {
      containers: [managedContainer(plan, "head")],
      listeningPorts: [],
    };
    harness.snapshots.worker = {
      containers: [managedContainer(plan, "worker")],
      listeningPorts: [],
    };
    let workerAttempts = 0;
    harness.removeContainer.mockImplementation(async (rolePlan, id) => {
      const shouldFailWorker = rolePlan.role === "worker" && workerAttempts === 0;
      workerAttempts += Number(rolePlan.role === "worker");
      const removeOwnedContainer = () => {
        harness.snapshots[rolePlan.role] = {
          ...harness.snapshots[rolePlan.role],
          containers: harness.snapshots[rolePlan.role].containers.filter(
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
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
    };

    await expect(
      cleanupDualSparkManagedVllm(plan, API_KEY, harness.deps, ownership),
    ).resolves.toEqual({
      ok: false,
      reason: "worker daemon unavailable",
      removedContainerIds: [HEAD_ID],
    });
    await expect(
      cleanupDualSparkManagedVllm(plan, API_KEY, harness.deps, ownership),
    ).resolves.toEqual({
      ok: true,
      removedContainerIds: [WORKER_ID],
      alreadyAbsentContainerIds: [HEAD_ID],
    });
  });
});
