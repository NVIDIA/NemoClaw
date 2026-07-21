// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  DUAL_STATION_SIMULATOR_API_KEY as API_KEY,
  cleanupDualStationSimulationFixtures,
  createDualStationLifecycleSimulator,
  createDualStationSimulationPlan,
  dualStationManagedRuns,
  dualStationSimulatorLabels,
  DUAL_STATION_SIMULATOR_LOCAL_GPU as LOCAL_GPU,
  DUAL_STATION_SIMULATOR_PEER_GPU as PEER_GPU,
} from "./vllm-dual-station-simulator.test-support";
import { DUAL_STATION_VLLM_RUNTIME } from "./vllm-station-cluster";
import {
  areDualStationManagedVllmContainersRunning,
  cleanupDualStationManagedVllm,
  DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL,
  DUAL_STATION_VLLM_CLUSTER_LABEL,
  DUAL_STATION_VLLM_ENDPOINT_LABEL,
  DUAL_STATION_VLLM_GPU_LABEL,
  DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
  DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL,
  DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL,
  DUAL_STATION_VLLM_MANAGED_LABEL,
  DUAL_STATION_VLLM_ROLE_LABEL,
  DUAL_STATION_VLLM_TRANSACTION_LABEL,
  DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
  type DualStationVllmRole,
  dualStationVllmApiKeyFingerprint,
  dualStationVllmClusterId,
  dualStationVllmLaunchContract,
  preflightDualStationGpuRuntime,
  preflightDualStationManagedVllm,
  startDualStationManagedVllm,
} from "./vllm-station-cluster-lifecycle";

afterEach(cleanupDualStationSimulationFixtures);

describe("connected dual-Station planner-to-lifecycle simulator", () => {
  it("passes a synthetic plan through launch, simulated registration, loss, recovery, and cleanup", async () => {
    const plan = createDualStationSimulationPlan();
    expect(plan).toMatchObject({
      masterAddress: "192.168.240.1",
      roceGidIndex: 3,
      runtime: DUAL_STATION_VLLM_RUNTIME,
      rails: [
        { local: { netdev: "cx8a0" }, peer: { netdev: "cx8b0" } },
        { local: { netdev: "cx8a1" }, peer: { netdev: "cx8b1" } },
      ],
    });

    const sim = createDualStationLifecycleSimulator();
    expect(sim.serviceRequest("/health")).toEqual({ status: 503, body: null });
    expect(preflightDualStationManagedVllm(plan, sim.deps)).toEqual({
      ok: true,
    });
    expect(await preflightDualStationGpuRuntime(plan, sim.deps)).toEqual({
      ok: true,
    });
    expect(areDualStationManagedVllmContainersRunning(plan, sim.deps)).toBe(false);

    const firstStart = await startDualStationManagedVllm(plan, { apiKey: API_KEY }, sim.deps);
    expect(firstStart).toMatchObject({ ok: true, reusedExisting: false });
    expect(areDualStationManagedVllmContainersRunning(plan, sim.deps)).toBe(true);
    expect(sim.healthDuringManagedLaunch.slice(0, 2)).toEqual([503, 503]);
    expect(sim.serviceRequest("/health")).toEqual({ status: 503, body: null });
    sim.registerWorker();
    expect(sim.serviceRequest("/health")).toEqual({ status: 200, body: null });
    expect(sim.serviceRequest("/v1/models").status).toBe(401);
    expect(sim.serviceRequest("/v1/models", `Bearer ${API_KEY}`)).toEqual({
      status: 200,
      body: { data: [{ id: DUAL_STATION_VLLM_RUNTIME.servedModelId }] },
    });
    expect(sim.serviceRequest("/v1/chat/completions", `Bearer ${API_KEY}`)).toEqual({
      status: 200,
      body: {
        choices: [{ message: { role: "assistant", content: "SIMULATED_OK" } }],
      },
    });

    const firstRuns = dualStationManagedRuns(sim.mutations);
    expect(firstRuns.map(({ target, nameOrId }) => [target, nameOrId])).toEqual([
      ["peer", DUAL_STATION_VLLM_WORKER_CONTAINER_NAME],
      ["local", DUAL_STATION_VLLM_HEAD_CONTAINER_NAME],
    ]);
    const expectedFingerprint = dualStationVllmApiKeyFingerprint(API_KEY);
    for (const [index, run] of firstRuns.entries()) {
      const role: DualStationVllmRole = index === 0 ? "worker" : "head";
      const labels = dualStationSimulatorLabels(run);
      expect(labels).toEqual({
        [DUAL_STATION_VLLM_MANAGED_LABEL]: "true",
        [DUAL_STATION_VLLM_ROLE_LABEL]: role,
        [DUAL_STATION_VLLM_ENDPOINT_LABEL]:
          role === "head" ? "http://192.168.240.1:8000" : "headless",
        [DUAL_STATION_VLLM_CLUSTER_LABEL]: dualStationVllmClusterId(plan),
        [DUAL_STATION_VLLM_GPU_LABEL]: role === "head" ? LOCAL_GPU : PEER_GPU,
        [DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL]: "2",
        [DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL]: dualStationVllmLaunchContract(plan, role),
        [DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL]: expectedFingerprint,
        [DUAL_STATION_VLLM_TRANSACTION_LABEL]: "1".padStart(32, "0"),
      });
      expect(JSON.stringify(run.args)).not.toContain(API_KEY);
      expect(JSON.stringify(labels)).not.toContain(API_KEY);
      expect(run.options?.env?.VLLM_API_KEY).toBe(role === "head" ? API_KEY : undefined);
    }
    for (const mutation of sim.mutations.filter((item) => !firstRuns.includes(item))) {
      expect(JSON.stringify(mutation.args ?? [])).not.toContain(API_KEY);
      expect(mutation.options?.env?.VLLM_API_KEY).toBeUndefined();
    }

    sim.loseWorker();
    expect(areDualStationManagedVllmContainersRunning(plan, sim.deps)).toBe(false);
    expect(sim.serviceRequest("/health")).toEqual({ status: 503, body: null });
    expect(sim.serviceRequest("/v1/chat/completions", `Bearer ${API_KEY}`).status).toBe(503);

    const recovered = await startDualStationManagedVllm(plan, { apiKey: API_KEY }, sim.deps);
    expect(recovered).toMatchObject({ ok: true, reusedExisting: false });
    expect(areDualStationManagedVllmContainersRunning(plan, sim.deps)).toBe(true);
    expect(sim.serviceRequest("/health")).toEqual({ status: 503, body: null });
    expect(sim.serviceRequest("/v1/chat/completions", `Bearer ${API_KEY}`).status).toBe(503);
    sim.registerWorker();
    expect(sim.serviceRequest("/health")).toEqual({ status: 200, body: null });
    expect(sim.serviceRequest("/v1/chat/completions", `Bearer ${API_KEY}`).status).toBe(200);

    const allRuns = dualStationManagedRuns(sim.mutations);
    expect(allRuns.map(({ target, nameOrId }) => [target, nameOrId])).toEqual([
      ["peer", DUAL_STATION_VLLM_WORKER_CONTAINER_NAME],
      ["local", DUAL_STATION_VLLM_HEAD_CONTAINER_NAME],
      ["peer", DUAL_STATION_VLLM_WORKER_CONTAINER_NAME],
      ["local", DUAL_STATION_VLLM_HEAD_CONTAINER_NAME],
    ]);
    expect(
      allRuns
        .slice(2)
        .map((run) => dualStationSimulatorLabels(run)[DUAL_STATION_VLLM_TRANSACTION_LABEL]),
    ).toEqual(["2".padStart(32, "0"), "2".padStart(32, "0")]);
    expect(
      allRuns.map(
        (run) => dualStationSimulatorLabels(run)[DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL],
      ),
    ).toEqual([
      dualStationVllmLaunchContract(plan, "worker"),
      dualStationVllmLaunchContract(plan, "head"),
      dualStationVllmLaunchContract(plan, "worker"),
      dualStationVllmLaunchContract(plan, "head"),
    ]);
    expect(sim.healthDuringManagedLaunch).toEqual([503, 503, 503, 503]);
    for (const [index, run] of allRuns.entries()) {
      const role: DualStationVllmRole = index % 2 === 0 ? "worker" : "head";
      const transactionId = index < 2 ? "1".padStart(32, "0") : "2".padStart(32, "0");
      expect(dualStationSimulatorLabels(run)).toEqual({
        [DUAL_STATION_VLLM_MANAGED_LABEL]: "true",
        [DUAL_STATION_VLLM_ROLE_LABEL]: role,
        [DUAL_STATION_VLLM_ENDPOINT_LABEL]:
          role === "head" ? "http://192.168.240.1:8000" : "headless",
        [DUAL_STATION_VLLM_CLUSTER_LABEL]: dualStationVllmClusterId(plan),
        [DUAL_STATION_VLLM_GPU_LABEL]: role === "head" ? LOCAL_GPU : PEER_GPU,
        [DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL]: "2",
        [DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL]: dualStationVllmLaunchContract(plan, role),
        [DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL]: expectedFingerprint,
        [DUAL_STATION_VLLM_TRANSACTION_LABEL]: transactionId,
      });
    }
    for (const mutation of sim.mutations) {
      expect(JSON.stringify(mutation.args ?? [])).not.toContain(API_KEY);
      expect(JSON.stringify(dualStationSimulatorLabels(mutation))).not.toContain(API_KEY);
      const isManagedHeadRun =
        mutation.kind === "run" && mutation.nameOrId === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME;
      expect(mutation.options?.env?.VLLM_API_KEY).toBe(isManagedHeadRun ? API_KEY : undefined);
    }

    const cleanup = await cleanupDualStationManagedVllm(plan, sim.deps);
    expect(cleanup).toMatchObject({ ok: true });
    expect(cleanup.ok && cleanup.removedContainerIds).toHaveLength(2);
    expect(areDualStationManagedVllmContainersRunning(plan, sim.deps)).toBe(false);
    expect(sim.serviceRequest("/health")).toEqual({ status: 503, body: null });
    expect(sim.containers.size).toBe(0);
  });
});
