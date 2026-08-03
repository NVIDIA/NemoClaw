// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DualSparkConfirmedManagedServingCapability,
  DualSparkDetectedManagedServingCapability,
} from "./dual-spark-discovery.js";
import type {
  CreateDualSparkVllmExecutorOptions,
  DualSparkExecutorStageNode,
} from "./dual-spark-executor.js";
import { fixtureDualSparkSelection } from "./dual-spark-fixture.test-support.js";
import {
  type DualSparkInstallerEffects,
  tryInstallDualSparkManagedVllm,
} from "./dual-spark-installer.js";
import type { DualSparkVllmLifecycleDeps } from "./dual-spark-lifecycle.js";

const API_KEY = "a".repeat(64);
const HEAD_ID = "b".repeat(64);
const WORKER_ID = "c".repeat(64);

function readyCapability(): DualSparkDetectedManagedServingCapability {
  const selection = fixtureDualSparkSelection();
  const host = (hostname: string, home: string, uid: number) => ({
    hostname,
    home,
    uid,
    gid: uid,
    runtimeSnapshot: { containers: [], listeningPorts: [] },
    storage: {
      huggingFace: {
        cacheRoot: `${home}/.cache/huggingface`,
        filesystemId: `${hostname}-home`,
        availableBytes: 400_000_000_000,
      },
      docker: {
        filesystemId: `${hostname}-docker`,
        availableBytes: 400_000_000_000,
      },
    },
  });
  return {
    kind: "ready",
    selectionIntent: "automatic",
    topology: selection.topologyQualification,
    local: host("spark-a", "/home/alice", 1000),
    peer: host("spark-b", "/home/bob", 1001),
    readiness: [],
    peerSshBindingStatePath: "/state/dual-spark-managed-serving.json",
    peerSshIdentity: { sshTarget: "spark-b" },
  } as unknown as DualSparkDetectedManagedServingCapability;
}

function confirmedCapability(
  detected: DualSparkDetectedManagedServingCapability,
): DualSparkConfirmedManagedServingCapability {
  return {
    ...detected,
    peerSshBinding: { peerTarget: "spark-b" },
    peerSshBindingHandle: "binding",
  } as unknown as DualSparkConfirmedManagedServingCapability;
}

function effects(): DualSparkInstallerEffects {
  return {
    prerequisites: vi.fn(() => ({ ok: true })),
    pullImage: vi.fn(async () => ({ ok: true })),
    downloadModel: vi.fn(async () => ({ ok: true })),
    printDownloadAuthentication: vi.fn(),
  };
}

function successfulStart(reusedExisting = false) {
  return {
    ok: true as const,
    reusedExisting,
    baseUrl: "http://192.168.100.10:8000",
    headContainerId: HEAD_ID,
    workerContainerId: WORKER_ID,
    apiKeyFingerprint: "d".repeat(64),
  };
}

describe("two-Spark managed vLLM installer selection", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("leaves non-Spark and conflict-free explicit legacy vLLM intent untouched", async () => {
    const probeCapability = vi.fn();
    await expect(
      tryInstallDualSparkManagedVllm(
        { platform: "station", nonInteractive: true, promptFn: vi.fn() },
        effects(),
        { probeCapability },
      ),
    ).resolves.toEqual({ kind: "not-selected" });
    await expect(
      tryInstallDualSparkManagedVllm(
        {
          platform: "spark",
          env: { NEMOCLAW_VLLM_MODEL: "nvidia/Qwen3.6-35B-A3B-NVFP4" },
          nonInteractive: true,
          promptFn: vi.fn(),
        },
        effects(),
        {
          probeCapability: () => ({
            kind: "not-selected",
            code: "no-match",
            reason: "no related distributed runtime",
          }),
        },
      ),
    ).resolves.toEqual({ kind: "not-selected" });
    expect(probeCapability).not.toHaveBeenCalled();
  });

  it("does not let explicit legacy intent bypass a related-runtime conflict", async () => {
    const installEffects = effects();
    const result = await tryInstallDualSparkManagedVllm(
      {
        platform: "spark",
        env: { NEMOCLAW_VLLM_MODEL: "nvidia/Qwen3.6-35B-A3B-NVFP4" },
        nonInteractive: true,
        promptFn: vi.fn(),
      },
      installEffects,
      {
        probeCapability: () => ({
          kind: "not-selected",
          code: "runtime-conflict",
          reason: "existing related setup was preserved",
        }),
        error: vi.fn(),
      },
    );
    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(installEffects.pullImage).not.toHaveBeenCalled();
    expect(installEffects.downloadModel).not.toHaveBeenCalled();
  });

  it("defers qualified explicit legacy intent without claiming binding state", async () => {
    const capability = readyCapability();
    const clearBinding = vi.fn();
    const revalidateCapability = vi.fn();
    const claimCapability = vi.fn();
    const resolveSelection = vi.fn();
    const result = await tryInstallDualSparkManagedVllm(
      {
        platform: "spark",
        env: { NEMOCLAW_VLLM_MODEL: "nvidia/Qwen3.6-35B-A3B-NVFP4" },
        nonInteractive: true,
        promptFn: vi.fn(),
      },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability,
        claimCapability,
        clearBinding,
        resolveSelection,
      },
    );
    expect(result).toEqual({ kind: "not-selected" });
    expect(resolveSelection).not.toHaveBeenCalled();
    expect(revalidateCapability).not.toHaveBeenCalled();
    expect(claimCapability).not.toHaveBeenCalled();
    expect(clearBinding).not.toHaveBeenCalled();
  });

  it("falls back only for an ordinary automatic no-match", async () => {
    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => ({
          kind: "not-selected",
          code: "no-match",
          reason: "no exact pair",
        }),
      },
    );
    expect(result).toEqual({ kind: "not-selected" });
  });

  it("stops on durable distributed ownership before capability probing or effects", async () => {
    const installEffects = effects();
    const probeCapability = vi.fn();
    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      installEffects,
      {
        assertNoRuntimeReceipts: () => {
          throw new Error("managed runtime receipt already exists");
        },
        probeCapability,
        error: vi.fn(),
      },
    );
    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(probeCapability).not.toHaveBeenCalled();
    expect(installEffects.pullImage).not.toHaveBeenCalled();
    expect(installEffects.downloadModel).not.toHaveBeenCalled();
  });

  it("stops before effects when a related runtime is already present", async () => {
    const installEffects = effects();
    const error = vi.fn();
    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      installEffects,
      {
        probeCapability: () => ({
          kind: "not-selected",
          code: "runtime-conflict",
          reason: "existing related setup was preserved",
        }),
        error,
      },
    );
    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("preserved"));
    expect(installEffects.pullImage).not.toHaveBeenCalled();
    expect(installEffects.downloadModel).not.toHaveBeenCalled();
  });

  it("admits the selected recipe port before prompting or claiming binding state", async () => {
    const selection = fixtureDualSparkSelection();
    const port = Number(
      selection.recipe.spec.serve.arguments.find(({ name }) => name === "--port")?.value,
    );
    const base = readyCapability();
    const capability = {
      ...base,
      local: {
        ...base.local,
        runtimeSnapshot: { ...base.local.runtimeSnapshot, listeningPorts: [port] },
      },
    } as DualSparkDetectedManagedServingCapability;
    const promptFn = vi.fn(async () => "yes");
    const revalidateCapability = vi.fn();
    const claimCapability = vi.fn();
    const installEffects = effects();

    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn },
      installEffects,
      {
        probeCapability: () => capability,
        resolveSelection: () => selection,
        revalidateCapability,
        claimCapability,
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(promptFn).not.toHaveBeenCalled();
    expect(revalidateCapability).not.toHaveBeenCalled();
    expect(claimCapability).not.toHaveBeenCalled();
    expect(installEffects.prerequisites).not.toHaveBeenCalled();
  });

  it("budgets the selected model and image at full size before prompting", async () => {
    const selection = fixtureDualSparkSelection();
    const base = readyCapability();
    const capability = {
      ...base,
      selectionIntent: "explicit",
      local: {
        ...base.local,
        storage: {
          ...base.local.storage,
          huggingFace: { ...base.local.storage.huggingFace, availableBytes: 1 },
        },
      },
    } as DualSparkDetectedManagedServingCapability;
    const promptFn = vi.fn(async () => "yes");
    const claimCapability = vi.fn();

    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn },
      effects(),
      {
        probeCapability: () => capability,
        resolveSelection: () => selection,
        claimCapability,
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(promptFn).not.toHaveBeenCalled();
    expect(claimCapability).not.toHaveBeenCalled();
  });

  it("rechecks the selected port after consent and before claiming binding state", async () => {
    const capability = readyCapability();
    const selection = fixtureDualSparkSelection();
    const port = Number(
      selection.recipe.spec.serve.arguments.find(({ name }) => name === "--port")?.value,
    );
    const revalidated = {
      ...capability,
      peer: {
        ...capability.peer,
        runtimeSnapshot: { ...capability.peer.runtimeSnapshot, listeningPorts: [port] },
      },
    } as DualSparkDetectedManagedServingCapability;
    const claimCapability = vi.fn();

    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn: async () => "yes" },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => revalidated,
        claimCapability,
        resolveSelection: () => selection,
        assertNoRuntimeReceipts: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(claimCapability).not.toHaveBeenCalled();
  });

  it("does not fall through to legacy setup when storage changes after consent", async () => {
    const capability = readyCapability();
    const revalidated = {
      ...capability,
      local: {
        ...capability.local,
        storage: {
          ...capability.local.storage,
          huggingFace: { ...capability.local.storage.huggingFace, availableBytes: 1 },
        },
      },
    } as DualSparkDetectedManagedServingCapability;
    const claimCapability = vi.fn();

    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn: async () => "yes" },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => revalidated,
        claimCapability,
        resolveSelection: () => fixtureDualSparkSelection(),
        assertNoRuntimeReceipts: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(claimCapability).not.toHaveBeenCalled();
  });

  it("does not fall through to legacy setup when selection changes after consent", async () => {
    const capability = readyCapability();
    const resolveSelection = vi
      .fn()
      .mockReturnValueOnce(fixtureDualSparkSelection())
      .mockReturnValueOnce({
        outcome: "no-match",
        code: "requirements-not-met",
        message: "selected requirements changed",
      });
    const claimCapability = vi.fn();

    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn: async () => "yes" },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability,
        resolveSelection,
        assertNoRuntimeReceipts: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(resolveSelection).toHaveBeenCalledTimes(2);
    expect(claimCapability).not.toHaveBeenCalled();
  });

  it("revalidates only after consent and stops before effects when the pair changed", async () => {
    const capability = readyCapability();
    const installEffects = effects();
    const clearBinding = vi.fn();
    const revalidateCapability = vi.fn(() => ({
      kind: "unavailable" as const,
      code: "runtime-conflict" as const,
      reason: "a related listener appeared after confirmation",
    }));
    const claimCapability = vi.fn();
    const promptFn = vi.fn(async () => {
      expect(revalidateCapability).not.toHaveBeenCalled();
      expect(installEffects.prerequisites).not.toHaveBeenCalled();
      return "yes";
    });
    const assertNoRuntimeReceipts = vi.fn();

    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn },
      installEffects,
      {
        probeCapability: () => capability,
        revalidateCapability,
        claimCapability,
        resolveSelection: () => fixtureDualSparkSelection(),
        assertNoRuntimeReceipts,
        clearBinding,
        log: vi.fn(),
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(assertNoRuntimeReceipts).toHaveBeenCalledTimes(2);
    expect(revalidateCapability).toHaveBeenCalledOnce();
    expect(claimCapability).not.toHaveBeenCalled();
    expect(installEffects.prerequisites).not.toHaveBeenCalled();
    expect(installEffects.pullImage).not.toHaveBeenCalled();
    expect(installEffects.downloadModel).not.toHaveBeenCalled();
    expect(clearBinding).not.toHaveBeenCalled();
  });

  it("applies selected-model access preflight before prompting or effects", async () => {
    const capability = readyCapability();
    const installEffects = effects();
    const promptFn = vi.fn(async () => "yes");
    const assertGatedModelAccess = vi.fn(() => {
      throw new Error("selected model access is unavailable");
    });
    const revalidateCapability = vi.fn();
    const claimCapability = vi.fn();

    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn },
      installEffects,
      {
        probeCapability: () => capability,
        resolveSelection: () => fixtureDualSparkSelection(),
        assertGatedModelAccess,
        revalidateCapability,
        claimCapability,
        log: vi.fn(),
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(assertGatedModelAccess).toHaveBeenCalledOnce();
    expect(promptFn).not.toHaveBeenCalled();
    expect(revalidateCapability).not.toHaveBeenCalled();
    expect(claimCapability).not.toHaveBeenCalled();
    expect(installEffects.prerequisites).not.toHaveBeenCalled();
    expect(installEffects.pullImage).not.toHaveBeenCalled();
    expect(installEffects.downloadModel).not.toHaveBeenCalled();
  });

  it("stages both exact nodes, launches, persists ownership, and retires temporary binding state", async () => {
    const capability = readyCapability();
    const confirmed = confirmedCapability(capability);
    const selection = fixtureDualSparkSelection();
    const installEffects = effects();
    const beforeInstall = vi.fn();
    const clearBinding = vi.fn();
    const persistReceipt = vi.fn();
    let capturedStage: DualSparkExecutorStageNode | undefined;
    const executor = {} as DualSparkVllmLifecycleDeps;
    const createExecutor = vi.fn((config: CreateDualSparkVllmExecutorOptions) => {
      capturedStage = config.stageNode;
      return executor;
    });
    const start = vi.fn(async (plan) => {
      expect(capturedStage).toBeDefined();
      await capturedStage!(
        { rolePlan: plan.roles.worker, preparation: plan.roles.worker.preparation },
        {
          role: "worker",
          dockerEnv: { DOCKER_HOST: "ssh://spark-b" },
          modelCacheRoot: capability.peer.storage.huggingFace.cacheRoot,
          peerSshBinding: confirmed.peerSshBinding,
        },
      );
      await capturedStage!(
        { rolePlan: plan.roles.head, preparation: plan.roles.head.preparation },
        {
          role: "head",
          dockerEnv: {},
          modelCacheRoot: capability.local.storage.huggingFace.cacheRoot,
        },
      );
      return successfulStart();
    });

    const result = await tryInstallDualSparkManagedVllm(
      {
        platform: "spark",
        env: {},
        nonInteractive: true,
        promptFn: vi.fn(),
        beforeInstall,
      },
      installEffects,
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmed,
        resolveSelection: () => selection,
        createExecutor: createExecutor as never,
        start: start as never,
        ensureApiKey: () => API_KEY,
        persistReceipt,
        clearBinding,
        log: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: true } });
    expect(beforeInstall).toHaveBeenCalledWith("deepseek-v4-flash-0731");
    expect(installEffects.pullImage).toHaveBeenCalledTimes(2);
    expect(installEffects.downloadModel).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ revision: selection.recipe.spec.model.revision }),
      { DOCKER_HOST: "ssh://spark-b" },
      {
        hostCacheDir: capability.peer.storage.huggingFace.cacheRoot,
        userIdentity: "1001:1001",
      },
    );
    expect(start).toHaveBeenCalledWith(expect.anything(), API_KEY, executor);
    expect(persistReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        headContainerId: HEAD_ID,
        workerContainerId: WORKER_ID,
        localCacheRoot: "/home/alice/.cache/huggingface",
        peerCacheRoot: "/home/bob/.cache/huggingface",
      }),
    );
    expect(clearBinding).toHaveBeenCalledWith(capability.peerSshBindingStatePath);
  });

  it("keeps a successful receipt-owned install when temporary binding retirement fails", async () => {
    const capability = readyCapability();
    const persistReceipt = vi.fn();
    const clearBinding = vi.fn(() => {
      throw new Error("temporary binding busy");
    });
    const warn = vi.fn();

    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => fixtureDualSparkSelection(),
        createExecutor: () => ({}) as DualSparkVllmLifecycleDeps,
        start: async () => successfulStart(),
        ensureApiKey: () => API_KEY,
        persistReceipt,
        clearBinding,
        log: vi.fn(),
        warn,
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: true } });
    expect(persistReceipt).toHaveBeenCalledOnce();
    expect(clearBinding).toHaveBeenCalledWith(capability.peerSshBindingStatePath);
    expect(persistReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      clearBinding.mock.invocationCallOrder[0]!,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("temporary two-Spark SSH state could not be retired"),
    );
  });

  it("cleans only a newly-created exact pair when receipt persistence fails", async () => {
    const capability = readyCapability();
    const selection = fixtureDualSparkSelection();
    const cleanup = vi.fn(async () => ({
      ok: true as const,
      removedContainerIds: [HEAD_ID, WORKER_ID],
    }));
    const clearBinding = vi.fn();
    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => selection,
        createExecutor: () => ({}) as DualSparkVllmLifecycleDeps,
        start: async () => successfulStart(false),
        cleanup,
        ensureApiKey: () => API_KEY,
        persistReceipt: () => {
          throw new Error("disk full");
        },
        clearBinding,
        log: vi.fn(),
        error: vi.fn(),
      },
    );
    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(clearBinding).toHaveBeenCalledWith(capability.peerSshBindingStatePath);
  });

  it("retains the claimed binding when receipt-failure rollback is incomplete", async () => {
    const capability = readyCapability();
    const clearBinding = vi.fn();
    const warn = vi.fn();
    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => fixtureDualSparkSelection(),
        createExecutor: () => ({}) as DualSparkVllmLifecycleDeps,
        start: async () => successfulStart(false),
        cleanup: async () => ({
          ok: false,
          reason: "worker cleanup failed",
          removedContainerIds: [HEAD_ID],
        }),
        ensureApiKey: () => API_KEY,
        persistReceipt: () => {
          throw new Error("disk full");
        },
        clearBinding,
        log: vi.fn(),
        error: vi.fn(),
        warn,
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(clearBinding).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retained two-Spark SSH ownership"));
  });

  it("retains the claimed binding when lifecycle rollback leaves a container", async () => {
    const capability = readyCapability();
    const clearBinding = vi.fn();
    const warn = vi.fn();
    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => fixtureDualSparkSelection(),
        createExecutor: () => ({}) as DualSparkVllmLifecycleDeps,
        start: async () => ({
          ok: false,
          code: "start-failed",
          reason: "head start failed",
          rollbackErrors: ["worker cleanup failed"],
        }),
        ensureApiKey: () => API_KEY,
        clearBinding,
        log: vi.fn(),
        error: vi.fn(),
        warn,
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(clearBinding).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retained two-Spark SSH ownership"));
  });

  it("does not remove an exact reused pair when receipt persistence fails", async () => {
    const capability = readyCapability();
    const cleanup = vi.fn();
    const clearBinding = vi.fn();
    await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => fixtureDualSparkSelection(),
        createExecutor: () => ({}) as DualSparkVllmLifecycleDeps,
        start: async () => successfulStart(true),
        cleanup,
        ensureApiKey: () => API_KEY,
        persistReceipt: () => {
          throw new Error("receipt changed");
        },
        clearBinding,
        log: vi.fn(),
        error: vi.fn(),
      },
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(clearBinding).not.toHaveBeenCalled();
  });

  it("does not claim or clear binding state when the operator declines", async () => {
    const capability = readyCapability();
    const clearBinding = vi.fn();
    const revalidateCapability = vi.fn();
    const claimCapability = vi.fn();
    const result = await tryInstallDualSparkManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn: async () => "no" },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability,
        claimCapability,
        resolveSelection: () => fixtureDualSparkSelection(),
        clearBinding,
        log: vi.fn(),
      },
    );
    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(revalidateCapability).not.toHaveBeenCalled();
    expect(claimCapability).not.toHaveBeenCalled();
    expect(clearBinding).not.toHaveBeenCalled();
  });
});
