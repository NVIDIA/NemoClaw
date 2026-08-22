// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  areContainersRunning: vi.fn(),
  cleanup: vi.fn(),
  commitLegacyMigration: vi.fn(),
  dockerCapture: vi.fn(),
  dockerForceRm: vi.fn(),
  dockerImageInspectFormat: vi.fn(),
  dockerPullWithProgressWatchdog: vi.fn(),
  dockerRunDetached: vi.fn(),
  dockerSpawn: vi.fn(),
  dockerStop: vi.fn(),
  ensureApiKey: vi.fn(),
  findUnwritableModelCachePath: vi.fn(),
  getManagedBaseUrl: vi.fn(),
  getGpuIndicesByName: vi.fn(),
  loadApiKey: vi.fn(),
  measureDirectorySizeBytes: vi.fn(),
  preflightGpuRuntime: vi.fn(),
  preflightOwnership: vi.fn(),
  persistRuntimeReceipt: vi.fn(),
  probeCapability: vi.fn(),
  recoverRuntime: vi.fn(),
  probeDockerStorage: vi.fn(),
  probeHostStorage: vi.fn(),
  runCapture: vi.fn(),
  runCurlProbe: vi.fn(),
  rollbackLegacyMigration: vi.fn(),
  startManaged: vi.fn(),
  stageModelSnapshot: vi.fn(),
  withLifecycle: vi.fn(),
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  runCapture: mocks.runCapture,
}));

vi.mock("../adapters/http/probe", () => ({
  runCurlProbe: mocks.runCurlProbe,
}));

vi.mock("../adapters/docker", () => ({
  dockerCapture: mocks.dockerCapture,
  dockerForceRm: mocks.dockerForceRm,
  dockerImageInspectFormat: mocks.dockerImageInspectFormat,
  dockerPullWithProgressWatchdog: mocks.dockerPullWithProgressWatchdog,
  dockerRunDetached: mocks.dockerRunDetached,
  dockerSpawn: mocks.dockerSpawn,
  dockerStop: mocks.dockerStop,
}));

vi.mock("./nim", () => ({
  getGpuIndicesByName: mocks.getGpuIndicesByName,
}));

vi.mock("./vllm-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vllm-storage")>()),
  findUnwritableModelCachePath: mocks.findUnwritableModelCachePath,
  measureDirectorySizeBytes: mocks.measureDirectorySizeBytes,
  probeDockerStorage: mocks.probeDockerStorage,
  probeHostStorage: mocks.probeHostStorage,
}));

vi.mock("./vllm-station-cluster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vllm-station-cluster")>()),
  probeDualStationVllmCapability: mocks.probeCapability,
}));

vi.mock("./vllm-station-model-staging", () => ({
  stageDualStationModelSnapshot: mocks.stageModelSnapshot,
}));

vi.mock("./vllm-station-cluster-lifecycle", () => ({
  areDualStationManagedVllmContainersRunning: mocks.areContainersRunning,
  cleanupDualStationManagedVllm: mocks.cleanup,
  commitDualStationLegacyMigration: mocks.commitLegacyMigration,
  getDualStationManagedVllmBaseUrl: mocks.getManagedBaseUrl,
  preflightDualStationGpuRuntime: mocks.preflightGpuRuntime,
  preflightDualStationManagedVllm: mocks.preflightOwnership,
  rollbackDualStationLegacyMigration: mocks.rollbackLegacyMigration,
  startDualStationManagedVllm: mocks.startManaged,
  withDualStationManagedVllmLifecycle: mocks.withLifecycle,
}));

vi.mock("./vllm-station-runtime-receipt", () => ({
  persistDualStationVllmRuntimeReceipt: mocks.persistRuntimeReceipt,
  recoverInstalledDualStationVllmRuntime: mocks.recoverRuntime,
}));

vi.mock("./vllm-api-key", () => ({
  ensureDualStationVllmApiKey: mocks.ensureApiKey,
  ensureManagedVllmApiKey: mocks.ensureApiKey,
  loadDualStationVllmApiKey: mocks.loadApiKey,
  loadManagedVllmApiKey: mocks.loadApiKey,
  managedVllmStateDir: () => path.join(os.homedir(), ".nemoclaw"),
}));

import { detectVllmProfile, installVllm, persistConfiguredManagedVllmRuntimeReceipt } from "./vllm";
import { DUAL_STATION_VLLM_RUNTIME, type DualStationVllmPlan } from "./vllm-station-cluster";
import {
  createDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";

const API_KEY = "ab".repeat(32);
const HEAD_ID = "a".repeat(64);
const WORKER_ID = "b".repeat(64);
const HEAD_BASE_URL = "http://192.168.100.1:8000";
const LEGACY_MIGRATION = {
  backupContainerName: `nemoclaw-vllm-legacy-${"1".repeat(32)}`,
  legacyContainerId: "c".repeat(64),
  transactionId: "1".repeat(32),
  headContainerId: HEAD_ID,
  workerContainerId: WORKER_ID,
};

function plan(): DualStationVllmPlan {
  return {
    peerSshBinding: sshFixture.binding,
    runtime: DUAL_STATION_VLLM_RUNTIME,
    local: {
      hostname: "station-a",
      home: "/home/nvidia",
      uid: 1000,
      gid: 1000,
      gpu: {
        index: 0,
        name: "NVIDIA GB300",
        uuid: "GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        totalMemoryMiB: 100_000,
        freeMemoryMiB: 95_000,
      },
    },
    peer: {
      hostname: "station-b",
      home: "/home/nvidia",
      uid: 1000,
      gid: 1000,
      gpu: {
        index: 0,
        name: "NVIDIA GB300",
        uuid: "GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        totalMemoryMiB: 100_000,
        freeMemoryMiB: 95_000,
      },
    },
    rails: [
      {
        index: 0,
        subnet: "192.168.100.0/30",
        local: {
          rdmaDevice: "mlx5_0",
          uverbsDevice: "/dev/infiniband/uverbs0",
          netdev: "enp1s0f0np0",
          macAddress: "02:00:00:00:00:01",
          pciAddress: "0000:01:00.0",
          address: "192.168.100.1",
        },
        peer: {
          rdmaDevice: "mlx5_0",
          uverbsDevice: "/dev/infiniband/uverbs0",
          netdev: "enp1s0f0np0",
          macAddress: "02:00:00:00:00:02",
          pciAddress: "0000:01:00.0",
          address: "192.168.100.2",
        },
      },
      {
        index: 1,
        subnet: "192.168.200.0/30",
        local: {
          rdmaDevice: "mlx5_1",
          uverbsDevice: "/dev/infiniband/uverbs1",
          netdev: "enp1s0f1np1",
          macAddress: "02:00:00:00:01:01",
          pciAddress: "0000:01:00.1",
          address: "192.168.200.1",
        },
        peer: {
          rdmaDevice: "mlx5_1",
          uverbsDevice: "/dev/infiniband/uverbs1",
          netdev: "enp1s0f1np1",
          macAddress: "02:00:00:00:01:02",
          pciAddress: "0000:01:00.1",
          address: "192.168.200.2",
        },
      },
    ],
    masterAddress: "192.168.100.1",
    roceGidIndex: 3,
  };
}

function successfulSpawn(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => child.emit("exit", 0));
  return child;
}

const originalEnv = { ...process.env };
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let mkdirSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let sshFixture: DualStationSshBindingFixture;

beforeEach(() => {
  vi.clearAllMocks();
  sshFixture = createDualStationSshBindingFixture();
  process.env.NEMOCLAW_VLLM_MODEL = "nemotron-3-ultra-550b-a55b";
  process.env.NEMOCLAW_DGX_STATION_PEER = "nvidia@station-b";
  process.env.HF_TOKEN = "hf_test";
  delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
  delete process.env.VLLM_API_KEY;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  mocks.probeCapability.mockReturnValue({
    kind: "ready",
    plan: plan(),
    peerModelSnapshot: "ready",
  });
  mocks.stageModelSnapshot.mockResolvedValue({ ok: true, transferred: true });
  mocks.findUnwritableModelCachePath.mockReturnValue(null);
  mocks.preflightOwnership.mockReturnValue({ ok: true });
  mocks.preflightGpuRuntime.mockReturnValue({ ok: true });
  mocks.getManagedBaseUrl.mockReturnValue(null);
  mocks.ensureApiKey.mockReturnValue(API_KEY);
  mocks.loadApiKey.mockReturnValue(API_KEY);
  mocks.startManaged.mockReturnValue({
    ok: true,
    baseUrl: HEAD_BASE_URL,
    headContainerId: HEAD_ID,
    workerContainerId: WORKER_ID,
    reusedExisting: false,
  });
  mocks.withLifecycle.mockImplementation(async (operation) => await operation());
  mocks.areContainersRunning.mockReturnValue(true);
  mocks.cleanup.mockReturnValue({ ok: true, removedContainerIds: [] });
  mocks.commitLegacyMigration.mockResolvedValue({ ok: true, cleanupWarnings: [] });
  mocks.persistRuntimeReceipt.mockImplementation(() => {});
  mocks.recoverRuntime.mockReturnValue({ kind: "not-installed" });
  mocks.rollbackLegacyMigration.mockResolvedValue({ ok: true });
  mocks.measureDirectorySizeBytes.mockReturnValue(0n);
  mocks.probeDockerStorage.mockReturnValue({
    ok: true,
    capacity: { availableBytes: 1_000_000_000_000n, path: "/docker", source: "Docker" },
  });
  mocks.probeHostStorage.mockReturnValue({
    ok: true,
    capacity: {
      availableBytes: 1_000_000_000_000n,
      path: path.join(os.homedir(), ".cache", "huggingface"),
      source: "Hugging Face cache",
    },
  });
  mocks.dockerImageInspectFormat.mockReturnValue(`sha256:${"c".repeat(64)}`);
  mocks.dockerPullWithProgressWatchdog.mockResolvedValue({
    status: 0,
    signal: null,
    output: "",
    timedOut: false,
    timeoutKind: null,
  });
  mocks.dockerSpawn.mockReturnValue(successfulSpawn());
  mocks.runCurlProbe.mockImplementation((args: string[]) => {
    const url = args.at(-1) ?? "";
    const authenticated = args.includes("--config");
    return url.endsWith("/health")
      ? { ok: true, httpStatus: 200, message: "ok", body: "" }
      : authenticated
        ? {
            ok: true,
            httpStatus: 200,
            message: "ok",
            body: JSON.stringify({ data: [{ id: "nemotron-ultra" }] }),
          }
        : { ok: false, httpStatus: 401, message: "unauthorized", body: "" };
  });
  mocks.runCapture.mockImplementation((args: readonly string[]) => {
    switch (args[0]) {
      case "sh":
        return "/usr/bin/tool\n";
      case "curl":
        return "200";
      default:
        return "";
    }
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  mkdirSpy.mockRestore();
  stdoutSpy.mockRestore();
  sshFixture.cleanup();
  process.env = { ...originalEnv };
});

describe("dual DGX Station running-runtime receipt adoption", () => {
  it("persists cleanup ownership for the exact configured running pair", async () => {
    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: true,
      persisted: true,
    });

    expect(mocks.probeCapability).toHaveBeenCalledOnce();
    expect(mocks.recoverRuntime).not.toHaveBeenCalled();
    expect(mocks.preflightOwnership).toHaveBeenCalledWith(plan());
    expect(mocks.areContainersRunning).toHaveBeenCalledWith(plan());
    expect(mocks.persistRuntimeReceipt).toHaveBeenCalledWith(plan());
  });

  it("fails closed when the configured pair no longer has exact ownership", async () => {
    mocks.preflightOwnership.mockReturnValue({
      ok: false,
      reason: "worker ownership changed",
    });

    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: false,
      reason: "worker ownership changed",
    });
    expect(mocks.persistRuntimeReceipt).not.toHaveBeenCalled();
  });

  it("fails closed when the managed peer configuration is missing", async () => {
    delete process.env.NEMOCLAW_DGX_STATION_PEER;

    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: false,
      reason: "the managed dual-Station peer configuration is missing",
    });
    expect(mocks.recoverRuntime).toHaveBeenCalledOnce();
    expect(mocks.probeCapability).not.toHaveBeenCalled();
    expect(mocks.persistRuntimeReceipt).not.toHaveBeenCalled();
  });

  it("recovers and revalidates persisted pair ownership for a later onboarding process", async () => {
    delete process.env.NEMOCLAW_DGX_STATION_PEER;
    const recoveredPlan = plan();
    let lifecycleActive = false;
    mocks.recoverRuntime.mockReturnValue({ kind: "ready", plan: recoveredPlan });
    mocks.withLifecycle.mockImplementation(async (operation) => {
      lifecycleActive = true;
      try {
        return await operation();
      } finally {
        lifecycleActive = false;
      }
    });
    mocks.recoverRuntime.mockImplementation(() => {
      expect(lifecycleActive).toBe(true);
      return { kind: "ready", plan: recoveredPlan };
    });
    mocks.preflightOwnership.mockImplementation(() => {
      expect(lifecycleActive).toBe(true);
      return { ok: true };
    });
    mocks.areContainersRunning.mockImplementation(() => {
      expect(lifecycleActive).toBe(true);
      return true;
    });

    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: true,
      persisted: true,
    });

    expect(mocks.recoverRuntime).toHaveBeenCalledOnce();
    expect(mocks.probeCapability).not.toHaveBeenCalled();
    expect(mocks.preflightOwnership).toHaveBeenCalledWith(recoveredPlan);
    expect(mocks.areContainersRunning).toHaveBeenCalledWith(recoveredPlan);
    expect(mocks.persistRuntimeReceipt).not.toHaveBeenCalled();
    expect(lifecycleActive).toBe(false);
  });

  it("fails closed when the receipt disappears before locked recovery", async () => {
    delete process.env.NEMOCLAW_DGX_STATION_PEER;
    let lifecycleActive = false;
    mocks.withLifecycle.mockImplementation(async (operation) => {
      lifecycleActive = true;
      try {
        mocks.recoverRuntime.mockImplementation(() => {
          expect(lifecycleActive).toBe(true);
          return { kind: "not-installed" };
        });
        return await operation();
      } finally {
        lifecycleActive = false;
      }
    });

    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: false,
      reason: "the managed dual-Station peer configuration is missing",
    });
    expect(mocks.recoverRuntime).toHaveBeenCalledOnce();
    expect(mocks.preflightOwnership).not.toHaveBeenCalled();
    expect(mocks.persistRuntimeReceipt).not.toHaveBeenCalled();
    expect(lifecycleActive).toBe(false);
  });

  it("fails closed when persisted pair ownership is unsafe", async () => {
    delete process.env.NEMOCLAW_DGX_STATION_PEER;
    mocks.recoverRuntime.mockReturnValue({
      kind: "unsafe",
      reason: "could not revalidate the managed pair: managed runtime identity changed",
    });

    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: false,
      reason:
        "the managed dual-Station cleanup receipt is unsafe: could not revalidate the managed pair: managed runtime identity changed",
    });
    expect(mocks.preflightOwnership).not.toHaveBeenCalled();
    expect(mocks.areContainersRunning).not.toHaveBeenCalled();
    expect(mocks.persistRuntimeReceipt).not.toHaveBeenCalled();
  });

  it("fails closed when a recovered pair changes before locked ownership validation", async () => {
    delete process.env.NEMOCLAW_DGX_STATION_PEER;
    const recoveredPlan = plan();
    mocks.recoverRuntime.mockReturnValue({ kind: "ready", plan: recoveredPlan });
    mocks.areContainersRunning.mockReturnValue(false);

    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: false,
      reason: "the managed dual-Station containers changed before cleanup ownership validation",
    });
    expect(mocks.preflightOwnership).toHaveBeenCalledWith(recoveredPlan);
    expect(mocks.persistRuntimeReceipt).not.toHaveBeenCalled();
  });
});

describe("dual DGX Station vLLM install orchestration", () => {
  it("pulls both immutable images, preflights GPUs, authenticates, and starts worker plus head", async () => {
    const clusterPlan = plan();
    let lifecycleActive = false;
    let capabilityCalls = 0;
    const probeImplementation = mocks.runCurlProbe.getMockImplementation();
    mocks.withLifecycle.mockImplementation(async (operation) => {
      lifecycleActive = true;
      try {
        return await operation();
      } finally {
        lifecycleActive = false;
      }
    });
    mocks.runCurlProbe.mockImplementation((args: string[], options?: unknown) => {
      expect(lifecycleActive).toBe(true);
      return probeImplementation?.(args, options);
    });
    mocks.areContainersRunning.mockImplementation(() => {
      expect(lifecycleActive).toBe(true);
      return true;
    });
    mocks.persistRuntimeReceipt.mockImplementation(() => {
      expect(lifecycleActive).toBe(true);
    });
    mocks.stageModelSnapshot.mockImplementation(async () => {
      expect(lifecycleActive).toBe(true);
      return { ok: true, transferred: false };
    });
    mocks.probeCapability.mockImplementation(() => {
      capabilityCalls += 1;
      expect(lifecycleActive).toBe(capabilityCalls >= 2);
      return {
        kind: "ready",
        plan: clusterPlan,
        peerModelSnapshot: "ready",
      };
    });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.preflightOwnership).toHaveBeenCalledWith(clusterPlan);
    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(2);
    const localPullOptions = mocks.dockerPullWithProgressWatchdog.mock.calls[0][1];
    const peerPullOptions = mocks.dockerPullWithProgressWatchdog.mock.calls[1][1];
    expect(peerPullOptions.env.DOCKER_HOST).toBe("ssh://nvidia@192.168.50.20");
    expect(peerPullOptions.env.PATH.split(":")[0]).toBe(
      clusterPlan.peerSshBinding.sshWrapperDirectory,
    );
    expect(localPullOptions.env.DOCKER_HOST).not.toBe(peerPullOptions.env.DOCKER_HOST);
    expect(localPullOptions.env.DOCKER_CONTEXT).toBe("default");
    expect(peerPullOptions.env.DOCKER_CONTEXT).toBeUndefined();
    expect(localPullOptions.env.VLLM_API_KEY).toBeUndefined();
    expect(peerPullOptions.env.VLLM_API_KEY).toBeUndefined();
    expect(mocks.preflightGpuRuntime).toHaveBeenCalledWith(clusterPlan);
    expect(mocks.preflightGpuRuntime.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.dockerPullWithProgressWatchdog.mock.invocationCallOrder[1],
    );
    expect(mocks.ensureApiKey.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.preflightGpuRuntime.mock.invocationCallOrder[0],
    );
    expect(mocks.ensureApiKey.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.dockerSpawn.mock.invocationCallOrder[0],
    );
    expect(mocks.startManaged).toHaveBeenCalledWith(clusterPlan, { apiKey: API_KEY });
    expect(mocks.startManaged.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.dockerSpawn.mock.invocationCallOrder[0],
    );
    expect(mocks.areContainersRunning).toHaveBeenCalledWith(clusterPlan);
    expect(mocks.persistRuntimeReceipt).toHaveBeenCalledWith(clusterPlan);
    expect(mocks.withLifecycle).toHaveBeenCalledTimes(2);
    expect(lifecycleActive).toBe(false);
    expect(mocks.probeCapability).toHaveBeenCalledTimes(3);
    expect(mocks.stageModelSnapshot).toHaveBeenCalledWith(clusterPlan);

    const readinessArgs = mocks.runCurlProbe.mock.calls[0][0] as string[];
    expect(readinessArgs).toContain(`${HEAD_BASE_URL}/health`);
    expect(readinessArgs.join(" ")).not.toContain("/v1/models");
    expect(mocks.runCurlProbe.mock.calls[0][1]).toMatchObject({ pinnedAddresses: [] });
    const unauthenticatedArgs = mocks.runCurlProbe.mock.calls[1][0] as string[];
    const authenticatedArgs = mocks.runCurlProbe.mock.calls[2][0] as string[];
    expect(unauthenticatedArgs).toContain(`${HEAD_BASE_URL}/v1/models`);
    expect(unauthenticatedArgs).not.toContain("--config");
    expect(authenticatedArgs).toContain("--config");
    expect(authenticatedArgs).not.toContain(API_KEY);
    expect(mocks.runCurlProbe.mock.calls[1][1]).toMatchObject({ pinnedAddresses: [] });
    expect(mocks.runCurlProbe.mock.calls[2][1]).toMatchObject({ pinnedAddresses: [] });
    expect(mocks.dockerSpawn.mock.calls[0][1].env.VLLM_API_KEY).toBeUndefined();
    expect(mocks.dockerSpawn.mock.calls[0][1].env.DOCKER_CONTEXT).toBe("default");
    expect(mocks.dockerImageInspectFormat.mock.calls[0][2].env.DOCKER_CONTEXT).toBe("default");
  });

  it("rejects a busy selected Station GPU before pulls, staging, or startup", async () => {
    const clusterPlan = plan();
    clusterPlan.peer.gpu.freeMemoryMiB = 89_000;
    mocks.probeCapability.mockReturnValue({
      kind: "ready",
      plan: clusterPlan,
      peerModelSnapshot: "staging-required",
    });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("station-b"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("GPU-bbbbbbbb"));
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.preflightGpuRuntime).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.stageModelSnapshot).not.toHaveBeenCalled();
    expect(mocks.startManaged).not.toHaveBeenCalled();
  });

  it("accepts volatile free-memory changes without treating them as topology changes", async () => {
    const initialPlan = plan();
    const stagedPlan = plan();
    const launchPlan = plan();
    stagedPlan.local.gpu.freeMemoryMiB = 94_000;
    launchPlan.local.gpu.freeMemoryMiB = 93_000;
    mocks.probeCapability
      .mockReturnValueOnce({
        kind: "ready",
        plan: initialPlan,
        peerModelSnapshot: "ready",
      })
      .mockReturnValueOnce({
        kind: "ready",
        plan: stagedPlan,
        peerModelSnapshot: "ready",
      })
      .mockReturnValueOnce({
        kind: "ready",
        plan: launchPlan,
        peerModelSnapshot: "ready",
      });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.startManaged).toHaveBeenCalledWith(launchPlan, { apiKey: API_KEY });
    expect(mocks.persistRuntimeReceipt).toHaveBeenCalledWith(launchPlan);
  });

  it("refuses a busy final Station sample before key creation or launch", async () => {
    const initialPlan = plan();
    const stagedPlan = plan();
    const launchPlan = plan();
    launchPlan.peer.gpu.freeMemoryMiB = 89_000;
    mocks.probeCapability
      .mockReturnValueOnce({
        kind: "ready",
        plan: initialPlan,
        peerModelSnapshot: "ready",
      })
      .mockReturnValueOnce({
        kind: "ready",
        plan: stagedPlan,
        peerModelSnapshot: "ready",
      })
      .mockReturnValueOnce({
        kind: "ready",
        plan: launchPlan,
        peerModelSnapshot: "ready",
      });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.ensureApiKey).not.toHaveBeenCalled();
    expect(mocks.startManaged).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("station-b"));
  });

  it("rolls back a newly started pair when durable rollback state cannot be written", async () => {
    const clusterPlan = plan();
    mocks.probeCapability.mockReturnValue({
      kind: "ready",
      plan: clusterPlan,
      peerModelSnapshot: "ready",
    });
    mocks.persistRuntimeReceipt.mockImplementation(() => {
      throw new Error("receipt write failed");
    });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.cleanup).toHaveBeenCalledWith(clusterPlan);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not persist the dual-Station cleanup receipt"),
    );
  });

  it("removes a committed migrated pair when durable rollback state cannot be written", async () => {
    const clusterPlan = plan();
    mocks.probeCapability.mockReturnValue({
      kind: "ready",
      plan: clusterPlan,
      peerModelSnapshot: "ready",
    });
    mocks.startManaged.mockReturnValue({
      ok: true,
      baseUrl: HEAD_BASE_URL,
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
      reusedExisting: false,
      legacyMigration: LEGACY_MIGRATION,
    });
    mocks.persistRuntimeReceipt.mockImplementation(() => {
      throw new Error("receipt write failed");
    });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.commitLegacyMigration).toHaveBeenCalledWith(clusterPlan, LEGACY_MIGRATION);
    expect(mocks.cleanup).toHaveBeenCalledWith(clusterPlan);
    expect(mocks.rollbackLegacyMigration).not.toHaveBeenCalled();
  });

  it("selects pinned Nemotron Ultra without prompting when an explicit peer qualifies", async () => {
    delete process.env.NEMOCLAW_VLLM_MODEL;
    const promptFn = vi.fn();
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn }),
    ).resolves.toEqual({ ok: true });

    expect(promptFn).not.toHaveBeenCalled();
    const [downloadArgs] = mocks.dockerSpawn.mock.calls[0] as [string[]];
    expect(downloadArgs).toEqual(
      expect.arrayContaining([
        "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
        "--revision",
        DUAL_STATION_VLLM_RUNTIME.modelRevision,
      ]),
    );
    expect(mocks.probeCapability).toHaveBeenCalledTimes(3);
  });

  it("installs the public Nemotron Ultra model without an HF token", async () => {
    delete process.env.NEMOCLAW_VLLM_MODEL;
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    const beforeInstall = vi.fn();
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, {
        hasImage: true,
        nonInteractive: true,
        promptFn: vi.fn(),
        beforeInstall,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeCapability).toHaveBeenCalledTimes(3);
    expect(beforeInstall).toHaveBeenCalledWith("nemotron-ultra");
    expect(mocks.preflightOwnership).toHaveBeenCalled();
    expect(mocks.dockerSpawn).toHaveBeenCalled();
    expect(mocks.stageModelSnapshot).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("gated on Hugging Face"));
  });

  it("skips only the model picker for an interactive qualified-peer install", async () => {
    delete process.env.NEMOCLAW_VLLM_MODEL;
    const promptFn = vi.fn().mockResolvedValue("y");
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: false, promptFn }),
    ).resolves.toEqual({ ok: true });

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(promptFn).toHaveBeenCalledWith("  Continue? [y/N]: ");
    expect(promptFn).not.toHaveBeenCalledWith(expect.stringContaining("Choose model"));
  });

  it("rejects a configured peer combined with an explicit non-Ultra model", async () => {
    process.env.NEMOCLAW_VLLM_MODEL = "deepseek-r1-distill-70b";
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    const beforeInstall = vi.fn();
    const promptFn = vi.fn();
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, {
        hasImage: true,
        nonInteractive: true,
        promptFn,
        beforeInstall,
      }),
    ).resolves.toEqual({ ok: false });

    expect(promptFn).not.toHaveBeenCalled();
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(mocks.probeCapability).not.toHaveBeenCalled();
    expect(mocks.stageModelSnapshot).not.toHaveBeenCalled();
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "  vLLM install failed: NEMOCLAW_DGX_STATION_PEER requires the DGX Station dual-serving model. " +
        "Unset NEMOCLAW_VLLM_MODEL or select nemotron-3-ultra-550b-a55b; the explicit model override remains authoritative.",
    );
  });

  it("stages a missing peer snapshot after download and requires a ready re-probe", async () => {
    const clusterPlan = plan();
    mocks.probeCapability
      .mockReturnValueOnce({
        kind: "ready",
        plan: clusterPlan,
        peerModelSnapshot: "staging-required",
      })
      .mockReturnValueOnce({
        kind: "ready",
        plan: clusterPlan,
        peerModelSnapshot: "ready",
      });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.stageModelSnapshot).toHaveBeenCalledWith(clusterPlan);
    expect(mocks.stageModelSnapshot.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.dockerSpawn.mock.invocationCallOrder[0],
    );
    expect(mocks.probeCapability.mock.invocationCallOrder[1]).toBeGreaterThan(
      mocks.stageModelSnapshot.mock.invocationCallOrder[0],
    );
    expect(mocks.startManaged.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.probeCapability.mock.invocationCallOrder[2],
    );
  });

  it("fails closed before re-probe or launch when peer snapshot staging fails", async () => {
    mocks.probeCapability.mockReturnValue({
      kind: "ready",
      plan: plan(),
      peerModelSnapshot: "staging-required",
    });
    mocks.stageModelSnapshot.mockResolvedValue({ ok: false, reason: "peer transfer timed out" });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.probeCapability).toHaveBeenCalledTimes(1);
    expect(mocks.startManaged).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("  vLLM install failed: peer transfer timed out");
  });

  it("fails before callbacks, prompts, or Docker work when a configured peer is incapable", async () => {
    const beforeInstall = vi.fn();
    mocks.probeCapability.mockReturnValue({
      kind: "unavailable",
      code: "peer-fabric-unavailable",
      reason: "peer fabric is incomplete",
    });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, {
        hasImage: true,
        nonInteractive: true,
        promptFn: vi.fn(),
        beforeInstall,
      }),
    ).resolves.toEqual({ ok: false });

    expect(beforeInstall).not.toHaveBeenCalled();
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.preflightOwnership).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.ensureApiKey).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "  Dual DGX Station setup unavailable: peer fabric is incomplete",
    );
  });

  it("stops before key creation and model download when either GPU runtime smoke fails", async () => {
    mocks.preflightGpuRuntime.mockReturnValue({
      ok: false,
      reason: "worker GPU smoke did not expose exactly the discovered GPU",
    });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.dockerPullWithProgressWatchdog).toHaveBeenCalledTimes(2);
    expect(mocks.ensureApiKey).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.startManaged).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "  vLLM install failed: worker GPU smoke did not expose exactly the discovered GPU",
    );
  });

  it("refuses teardown when the qualified topology changes during the model download", async () => {
    const originalPlan = plan();
    const changedPlan = plan();
    changedPlan.peer.hostname = "station-b-replaced";
    mocks.probeCapability
      .mockReturnValueOnce({
        kind: "ready",
        plan: originalPlan,
        peerModelSnapshot: "ready",
      })
      .mockReturnValueOnce({
        kind: "ready",
        plan: changedPlan,
        peerModelSnapshot: "ready",
      });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.dockerSpawn).toHaveBeenCalledTimes(1);
    expect(mocks.ensureApiKey).not.toHaveBeenCalled();
    expect(mocks.startManaged).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "  vLLM install failed: dual-Station topology changed during download; rerun setup against a stable pair.",
    );
  });

  it("commits legacy retirement only after readiness, auth, and final pair validation", async () => {
    mocks.startManaged.mockReturnValue({
      ok: true,
      baseUrl: HEAD_BASE_URL,
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
      reusedExisting: false,
      legacyMigration: LEGACY_MIGRATION,
    });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.commitLegacyMigration).toHaveBeenCalledWith(plan(), LEGACY_MIGRATION);
    expect(mocks.commitLegacyMigration.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.areContainersRunning.mock.invocationCallOrder[0],
    );
    expect(mocks.commitLegacyMigration.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.runCurlProbe.mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(mocks.rollbackLegacyMigration).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    {
      failure: "readiness",
      configureFailure: () => {
        mocks.runCurlProbe.mockReturnValue({ ok: false, httpStatus: 503, message: "loading" });
        mocks.dockerCapture.mockReturnValue("");
      },
      expectedCommitCalls: 0,
    },
    {
      failure: "authentication",
      configureFailure: () => {
        mocks.runCurlProbe.mockImplementation((args: string[]) => ({
          ok: true,
          httpStatus: 200,
          message: "ok",
          body: args.at(-1)?.endsWith("/v1/models")
            ? JSON.stringify({ data: [{ id: "nemotron-ultra" }] })
            : "",
        }));
      },
      expectedCommitCalls: 0,
    },
    {
      failure: "final running check",
      configureFailure: () => mocks.areContainersRunning.mockReturnValue(false),
      expectedCommitCalls: 0,
    },
    {
      failure: "commit validation",
      configureFailure: () =>
        mocks.commitLegacyMigration.mockResolvedValue({
          ok: false,
          reason: "new dual-Station transaction changed before commit",
        }),
      expectedCommitCalls: 1,
    },
  ])("restores legacy state when external $failure fails", async ({
    configureFailure,
    expectedCommitCalls,
  }) => {
    mocks.startManaged.mockReturnValue({
      ok: true,
      baseUrl: HEAD_BASE_URL,
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
      reusedExisting: false,
      legacyMigration: LEGACY_MIGRATION,
    });
    configureFailure();
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.rollbackLegacyMigration).toHaveBeenCalledWith(plan(), LEGACY_MIGRATION);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.commitLegacyMigration).toHaveBeenCalledTimes(expectedCommitCalls);
  });

  it("rolls back a new pair when unauthenticated model inventory is exposed", async () => {
    mocks.runCurlProbe.mockImplementation((args: string[]) => ({
      ok: true,
      httpStatus: 200,
      message: "ok",
      body: args.at(-1)?.endsWith("/v1/models")
        ? JSON.stringify({ data: [{ id: "nemotron-ultra" }] })
        : "",
    }));
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ masterAddress: "192.168.100.1" }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "  vLLM install failed: unauthenticated model inventory returned HTTP 200; expected vLLM to reject it with HTTP 401",
    );
  });

  it("stops before storage or image work when container ownership is not exact", async () => {
    mocks.preflightOwnership.mockReturnValue({
      ok: false,
      reason: "worker container ownership is foreign; refusing mutation",
    });
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });

    await expect(
      installVllm(profile!, { hasImage: true, nonInteractive: true, promptFn: vi.fn() }),
    ).resolves.toEqual({ ok: false });

    expect(mocks.probeHostStorage).not.toHaveBeenCalled();
    expect(mocks.dockerImageInspectFormat).not.toHaveBeenCalled();
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
    expect(mocks.startManaged).not.toHaveBeenCalled();
  });
});
