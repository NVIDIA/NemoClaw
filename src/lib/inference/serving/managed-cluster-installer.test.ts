// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ManagedClusterConfirmedManagedServingCapability,
  ManagedClusterDetectedManagedServingCapability,
} from "./managed-cluster-discovery.js";
import type {
  CreateManagedClusterVllmExecutorOptions,
  ManagedClusterExecutorStageNode,
} from "./managed-cluster-executor.js";
import { fixtureManagedClusterSelection } from "./managed-cluster-fixture.test-support.js";
import {
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
} from "./adapter-registry.js";
import {
  type ManagedClusterInstallerEffects,
  tryInstallManagedClusterManagedVllm,
} from "./managed-cluster-installer.js";
import type { ManagedClusterVllmLifecycleDeps } from "./managed-cluster-lifecycle.js";
import type {
  HostLocalInferenceServingRecipe,
  ResolvedHostLocalInferenceSelection,
} from "./types.js";

const API_KEY = "a".repeat(64);
const HEAD_ID = "b".repeat(64);
const WORKER_ID = "c".repeat(64);

function readyCapability(): ManagedClusterDetectedManagedServingCapability {
  const selection = fixtureManagedClusterSelection();
  const host = (nodeId: string, hostname: string, home: string, uid: number) => ({
    nodeId,
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
    local: host("spark-head", "spark-a", "/home/alice", 1000),
    peers: [host("spark-worker", "spark-b", "/home/bob", 1001)],
    readiness: [],
    sshClaims: [
      {
        nodeId: "spark-worker",
        statePath: "/state/managed-cluster-managed-serving.json.spark-worker",
        identity: { sshTarget: "spark-b" },
      },
    ],
  } as unknown as ManagedClusterDetectedManagedServingCapability;
}

function confirmedCapability(
  detected: ManagedClusterDetectedManagedServingCapability,
): ManagedClusterConfirmedManagedServingCapability {
  return {
    ...detected,
    sshBindings: [
      {
        ...detected.sshClaims[0],
        binding: { peerTarget: "spark-b" },
        handle: "binding",
      },
    ],
  } as unknown as ManagedClusterConfirmedManagedServingCapability;
}

function effects(): ManagedClusterInstallerEffects {
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
    containers: [
      { nodeId: "spark-head", containerId: HEAD_ID },
      { nodeId: "spark-worker", containerId: WORKER_ID },
    ],
    apiKeyFingerprint: "d".repeat(64),
  };
}

describe("managed-cluster vLLM installer selection", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("leaves non-Spark and conflict-free explicit legacy vLLM intent untouched", async () => {
    const probeCapability = vi.fn(() => ({
      kind: "not-selected" as const,
      code: "no-match" as const,
      reason: "no related distributed runtime",
    }));
    await expect(
      tryInstallManagedClusterManagedVllm(
        { platform: "station", nonInteractive: true, promptFn: vi.fn() },
        effects(),
        { probeCapability },
      ),
    ).resolves.toEqual({ kind: "not-selected" });
    await expect(
      tryInstallManagedClusterManagedVllm(
        {
          platform: "spark",
          env: { NEMOCLAW_VLLM_MODEL: "nvidia/Qwen3.6-35B-A3B-NVFP4" },
          nonInteractive: true,
          promptFn: vi.fn(),
        },
        effects(),
        { probeCapability },
      ),
    ).resolves.toEqual({ kind: "not-selected" });
    expect(probeCapability).toHaveBeenCalledOnce();
  });

  it("defers an explicit host-local preset to the single-host installer", async () => {
    const capability = readyCapability();
    const managed = fixtureManagedClusterSelection();
    const { topologyQualification: _topology, ...selection } = managed;
    const { bindings: _bindings, ...spec } = managed.recipe.spec;
    const hostLocalRecipe = {
      ...managed.recipe,
      spec: {
        ...spec,
        backend: "vllm",
        execution: {
          materializerRef: HOST_LOCAL_VLLM_MATERIALIZER_REF,
          lifecycleRef: HOST_LOCAL_VLLM_LIFECYCLE_REF,
        },
      },
    } satisfies HostLocalInferenceServingRecipe;
    const hostLocalSelection: ResolvedHostLocalInferenceSelection = {
      ...selection,
      selection: "explicit",
      recipe: hostLocalRecipe,
    };
    const installEffects = effects();
    const revalidateCapability = vi.fn();
    const claimCapability = vi.fn();

    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      installEffects,
      {
        probeCapability: () => capability,
        resolveSelection: () => hostLocalSelection,
        revalidateCapability,
        claimCapability,
        assertNoRuntimeReceipts: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "not-selected" });
    expect(revalidateCapability).not.toHaveBeenCalled();
    expect(claimCapability).not.toHaveBeenCalled();
    expect(installEffects.pullImage).not.toHaveBeenCalled();
  });

  it("does not let explicit legacy intent bypass a related-runtime conflict", async () => {
    const installEffects = effects();
    const result = await tryInstallManagedClusterManagedVllm(
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
    const result = await tryInstallManagedClusterManagedVllm(
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
    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => ({
          kind: "not-selected",
          code: "no-match",
          reason: "no exact cluster",
        }),
      },
    );
    expect(result).toEqual({ kind: "not-selected" });
  });

  it("stops on durable distributed ownership before capability probing or effects", async () => {
    const installEffects = effects();
    const probeCapability = vi.fn();
    const result = await tryInstallManagedClusterManagedVllm(
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
    const result = await tryInstallManagedClusterManagedVllm(
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
    const selection = fixtureManagedClusterSelection();
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
    } as ManagedClusterDetectedManagedServingCapability;
    const promptFn = vi.fn(async () => "yes");
    const revalidateCapability = vi.fn();
    const claimCapability = vi.fn();
    const installEffects = effects();

    const result = await tryInstallManagedClusterManagedVllm(
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

  it("uses the configured vLLM port for managed-cluster admission", async () => {
    const selection = fixtureManagedClusterSelection();
    const base = readyCapability();
    const capability = {
      ...base,
      local: {
        ...base.local,
        runtimeSnapshot: { ...base.local.runtimeSnapshot, listeningPorts: [19_000] },
      },
    } as ManagedClusterDetectedManagedServingCapability;
    const materializePlan = vi.fn();

    const result = await tryInstallManagedClusterManagedVllm(
      {
        platform: "spark",
        env: { NEMOCLAW_VLLM_PORT: "19000" },
        nonInteractive: true,
        promptFn: vi.fn(),
      },
      effects(),
      {
        probeCapability: () => capability,
        resolveSelection: () => selection,
        materializePlan,
        error: vi.fn(),
      },
    );

    expect(result).toEqual({ kind: "handled", result: { ok: false } });
    expect(materializePlan).not.toHaveBeenCalled();
  });

  it("budgets the selected model and image at full size before prompting", async () => {
    const selection = fixtureManagedClusterSelection();
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
    } as ManagedClusterDetectedManagedServingCapability;
    const promptFn = vi.fn(async () => "yes");
    const claimCapability = vi.fn();

    const result = await tryInstallManagedClusterManagedVllm(
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
    const selection = fixtureManagedClusterSelection();
    const port = Number(
      selection.recipe.spec.serve.arguments.find(({ name }) => name === "--port")?.value,
    );
    const revalidated = {
      ...capability,
      peers: capability.peers.map((peer) => ({
        ...peer,
        runtimeSnapshot: { ...peer.runtimeSnapshot, listeningPorts: [port] },
      })),
    } as ManagedClusterDetectedManagedServingCapability;
    const claimCapability = vi.fn();

    const result = await tryInstallManagedClusterManagedVllm(
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
    } as ManagedClusterDetectedManagedServingCapability;
    const claimCapability = vi.fn();

    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn: async () => "yes" },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => revalidated,
        claimCapability,
        resolveSelection: () => fixtureManagedClusterSelection(),
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
      .mockReturnValueOnce(fixtureManagedClusterSelection())
      .mockReturnValueOnce({
        outcome: "no-match",
        code: "requirements-not-met",
        message: "selected requirements changed",
      });
    const claimCapability = vi.fn();

    const result = await tryInstallManagedClusterManagedVllm(
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

  it("revalidates only after consent and stops before effects when the cluster changed", async () => {
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

    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn },
      installEffects,
      {
        probeCapability: () => capability,
        revalidateCapability,
        claimCapability,
        resolveSelection: () => fixtureManagedClusterSelection(),
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

    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn },
      installEffects,
      {
        probeCapability: () => capability,
        resolveSelection: () => fixtureManagedClusterSelection(),
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
    const selection = fixtureManagedClusterSelection();
    const installEffects = effects();
    const beforeInstall = vi.fn();
    const clearBinding = vi.fn();
    const persistReceipt = vi.fn();
    const stageCalls: string[] = [];
    let capturedStage: ManagedClusterExecutorStageNode | undefined;
    const executor = {} as ManagedClusterVllmLifecycleDeps;
    const createExecutor = vi.fn((config: CreateManagedClusterVllmExecutorOptions) => {
      capturedStage = config.stageNode;
      return executor;
    });
    const start = vi.fn(async (plan) => {
      stageCalls.push(plan.roles[1].nodeId);
      await capturedStage!(
        { rolePlan: plan.roles[1], preparation: plan.roles[1].preparation },
        {
          nodeId: plan.roles[1].nodeId,
          dockerEnv: { DOCKER_HOST: "ssh://spark-b" },
          modelCacheRoot: capability.peers[0].storage.huggingFace.cacheRoot,
          sshBinding: confirmed.sshBindings[0].binding,
        },
      );
      stageCalls.push(plan.roles[0].nodeId);
      await capturedStage!(
        { rolePlan: plan.roles[0], preparation: plan.roles[0].preparation },
        {
          nodeId: plan.roles[0].nodeId,
          dockerEnv: {},
          modelCacheRoot: capability.local.storage.huggingFace.cacheRoot,
        },
      );
      return successfulStart();
    });

    const result = await tryInstallManagedClusterManagedVllm(
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
    expect(capturedStage).toBeDefined();
    expect(stageCalls).toEqual(["spark-worker", "spark-head"]);
    expect(beforeInstall).toHaveBeenCalledWith("deepseek-v4-flash-0731");
    expect(installEffects.pullImage).toHaveBeenCalledTimes(2);
    expect(installEffects.downloadModel).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ revision: selection.recipe.spec.model.revision }),
      { DOCKER_HOST: "ssh://spark-b" },
      {
        hostCacheDir: capability.peers[0].storage.huggingFace.cacheRoot,
        userIdentity: "1001:1001",
      },
    );
    expect(start).toHaveBeenCalledWith(expect.anything(), API_KEY, executor);
    expect(persistReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [
          expect.objectContaining({
            nodeId: "spark-head",
            containerId: HEAD_ID,
            cacheRoot: "/home/alice/.cache/huggingface",
          }),
          expect.objectContaining({
            nodeId: "spark-worker",
            containerId: WORKER_ID,
            cacheRoot: "/home/bob/.cache/huggingface",
          }),
        ],
      }),
    );
    expect(clearBinding).toHaveBeenCalledWith(capability.sshClaims[0].statePath);
  });

  it("keeps a successful receipt-owned install when temporary binding retirement fails", async () => {
    const capability = readyCapability();
    const persistReceipt = vi.fn();
    const clearBinding = vi.fn(() => {
      throw new Error("temporary binding busy");
    });
    const warn = vi.fn();

    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => fixtureManagedClusterSelection(),
        createExecutor: () => ({}) as ManagedClusterVllmLifecycleDeps,
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
    expect(clearBinding).toHaveBeenCalledWith(capability.sshClaims[0].statePath);
    expect(persistReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      clearBinding.mock.invocationCallOrder[0]!,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("temporary managed cluster SSH state could not be retired"),
    );
  });

  it("cleans only a newly-created exact cluster when receipt persistence fails", async () => {
    const capability = readyCapability();
    const selection = fixtureManagedClusterSelection();
    const cleanup = vi.fn(async () => ({
      ok: true as const,
      removedContainerIds: [HEAD_ID, WORKER_ID],
    }));
    const clearBinding = vi.fn();
    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => selection,
        createExecutor: () => ({}) as ManagedClusterVllmLifecycleDeps,
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
    expect(clearBinding).toHaveBeenCalledWith(capability.sshClaims[0].statePath);
  });

  it("retains the claimed binding when receipt-failure rollback is incomplete", async () => {
    const capability = readyCapability();
    const clearBinding = vi.fn();
    const warn = vi.fn();
    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => fixtureManagedClusterSelection(),
        createExecutor: () => ({}) as ManagedClusterVllmLifecycleDeps,
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("retained managed cluster SSH ownership"),
    );
  });

  it("retains the claimed binding when lifecycle rollback leaves a container", async () => {
    const capability = readyCapability();
    const clearBinding = vi.fn();
    const warn = vi.fn();
    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => fixtureManagedClusterSelection(),
        createExecutor: () => ({}) as ManagedClusterVllmLifecycleDeps,
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("retained managed cluster SSH ownership"),
    );
  });

  it("does not remove an exact reused cluster when receipt persistence fails", async () => {
    const capability = readyCapability();
    const cleanup = vi.fn();
    const clearBinding = vi.fn();
    await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: true, promptFn: vi.fn() },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability: () => capability,
        claimCapability: () => confirmedCapability(capability),
        resolveSelection: () => fixtureManagedClusterSelection(),
        createExecutor: () => ({}) as ManagedClusterVllmLifecycleDeps,
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
    const result = await tryInstallManagedClusterManagedVllm(
      { platform: "spark", env: {}, nonInteractive: false, promptFn: async () => "no" },
      effects(),
      {
        probeCapability: () => capability,
        revalidateCapability,
        claimCapability,
        resolveSelection: () => fixtureManagedClusterSelection(),
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
