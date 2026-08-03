// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadManagedInferenceCatalog } from "./serving/catalog";
import { managedInferenceDigest } from "./serving/catalog-integrity";
import type { CompiledManagedInferenceCatalog } from "./serving/catalog-types";
import { fixtureManagedClusterSelection } from "./serving/managed-cluster-fixture.test-support";
import {
  type ManagedClusterNodeSnapshot,
  type ManagedClusterVllmLifecycleDeps,
  managedClusterVllmApiKeyFingerprint,
} from "./serving/managed-cluster-lifecycle";
import {
  MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL,
  MANAGED_CLUSTER_TRANSACTION_LABEL,
  type ManagedClusterVllmPlan,
  type ManagedClusterVllmRolePlan,
  materializeManagedClusterVllmPlan,
} from "./serving/managed-cluster-materialize";
import {
  cleanupInstalledManagedClusterVllmRuntime,
  loadManagedClusterVllmRuntimeReceipt,
  managedClusterVllmRuntimeReceiptPath,
  type PersistManagedClusterVllmRuntimeReceiptInput,
  persistManagedClusterVllmRuntimeReceipt,
  recoverInstalledManagedClusterVllmEndpoint,
} from "./serving/managed-cluster-runtime-receipt";
import { MANAGED_CLUSTER_MANAGED_SERVING_STATE_FILE } from "./serving/managed-cluster-runtime-receipt-path";
import { managedClusterTopologyOutputDigest } from "./serving/managed-cluster-topology";
import {
  clearDualStationSshBinding,
  copyDualStationSshBinding,
  type DualStationSshBinding,
  encodeDualStationSshBindingHandoff,
} from "./vllm-station-ssh-binding";
import {
  createDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";

const API_KEY = "a".repeat(64);
const HEAD_ID = "b".repeat(64);
const WORKER_ID = "c".repeat(64);
const TRANSACTION_ID = "d".repeat(32);

let root: string;
let stateDir: string;
let sshFixture: DualStationSshBindingFixture;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-cluster-runtime-receipt-"));
  stateDir = path.join(root, ".nemoclaw");
  sshFixture = createDualStationSshBindingFixture("nvidia@spark-worker.local");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("./serving/generated/catalog.json");
  vi.resetModules();
  sshFixture.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

function plan(sshBinding: DualStationSshBinding = sshFixture.binding): ManagedClusterVllmPlan {
  const selection = fixtureManagedClusterSelection();
  const sourceTopology = selection.topologyQualification;
  const output = {
    ...sourceTopology.output,
    peers: sourceTopology.output.peers.map((peer) => ({
      ...peer,
      target: sshBinding.peerTarget,
      sshBindingHandle: encodeDualStationSshBindingHandoff(sshBinding),
    })),
  };
  return materializeManagedClusterVllmPlan({
    ...selection,
    topologyQualification: {
      ...sourceTopology,
      outputDigest: managedClusterTopologyOutputDigest(output),
      output,
    },
  });
}

function input(
  sshBinding: DualStationSshBinding = sshFixture.binding,
): PersistManagedClusterVllmRuntimeReceiptInput {
  const runtimePlan = plan(sshBinding);
  return {
    plan: runtimePlan,
    nodes: runtimePlan.roles.map((rolePlan) => ({
      nodeId: rolePlan.nodeId,
      cacheRoot: "/home/nvidia/.cache/huggingface",
      containerId: rolePlan.rank === 0 ? HEAD_ID : WORKER_ID,
      ...(rolePlan.execution.kind === "ssh"
        ? {
            sshBinding,
            discoveryStatePath: path.join(stateDir, MANAGED_CLUSTER_MANAGED_SERVING_STATE_FILE),
          }
        : {}),
    })),
    apiKeyFingerprint: managedClusterVllmApiKeyFingerprint(API_KEY),
  };
}

function catalogWithUnrelatedProfile(): CompiledManagedInferenceCatalog {
  const current = loadManagedInferenceCatalog();
  const selectedPreset = current.presets[0]!;
  const selectedRecipe = current.recipes[0]!;
  const unrelatedRecipe = {
    ...selectedRecipe.definition,
    metadata: { ...selectedRecipe.definition.metadata, id: "vllm.unrelated.spark-dual.v1" },
  };
  const unrelatedPreset = {
    ...selectedPreset.definition,
    metadata: { ...selectedPreset.definition.metadata, id: "vllm.unrelated.spark-dual" },
    spec: {
      ...selectedPreset.definition.spec,
      plan: {
        ...selectedPreset.definition.spec.plan,
        recipeRef: unrelatedRecipe.metadata.id,
      },
    },
  };
  const sourceFiles = [
    ...current.sourceFiles,
    {
      path: "managed-inference/presets/vllm.unrelated.spark-dual.yaml",
      digest: `sha256:${"1".repeat(64)}`,
    },
    {
      path: "managed-inference/recipes/vllm.unrelated.spark-dual.v1.yaml",
      digest: `sha256:${"2".repeat(64)}`,
    },
  ] as const;
  const contents = {
    compilerVersion: current.compilerVersion,
    presets: [
      ...current.presets,
      {
        definition: unrelatedPreset,
        definitionDigest: managedInferenceDigest(unrelatedPreset),
        sourceFile: sourceFiles.at(-2)!.path,
      },
    ],
    recipes: [
      ...current.recipes,
      {
        definition: unrelatedRecipe,
        definitionDigest: managedInferenceDigest(unrelatedRecipe),
        sourceFile: sourceFiles.at(-1)!.path,
      },
    ],
    schemaVersion: current.schemaVersion,
    sourceFiles,
    sourceRevision: managedInferenceDigest(sourceFiles),
  } as const;
  return { ...contents, catalogDigest: managedInferenceDigest(contents) };
}

function persistWithDiscoveryBinding(): {
  discoveryBindingPath: string;
  discoveryStatePath: string;
  runtime: ReturnType<typeof persistManagedClusterVllmRuntimeReceipt>;
} {
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const discoveryStatePath = path.join(stateDir, MANAGED_CLUSTER_MANAGED_SERVING_STATE_FILE);
  const binding = copyDualStationSshBinding(discoveryStatePath, sshFixture.binding);
  return {
    discoveryBindingPath: `${discoveryStatePath}.ssh-binding`,
    discoveryStatePath,
    runtime: persistManagedClusterVllmRuntimeReceipt(input(binding), { stateDir }),
  };
}

function snapshot(
  rolePlan: ManagedClusterVllmRolePlan,
  containerId: string,
): ManagedClusterNodeSnapshot {
  return {
    containers: [
      {
        id: containerId,
        name: rolePlan.containerName,
        image: rolePlan.image,
        running: true,
        healthy: true,
        labels: {
          ...rolePlan.baseLabels,
          [MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL]: managedClusterVllmApiKeyFingerprint(API_KEY),
          [MANAGED_CLUSTER_TRANSACTION_LABEL]: TRANSACTION_ID,
        },
      },
    ],
    listeningPorts:
      rolePlan.role === "head" ? [rolePlan.endpoint ? 8000 : 0, 25000].filter(Boolean) : [25000],
  };
}

function cleanupDeps(
  runtimePlan: ManagedClusterVllmPlan,
  ids: { head: string; worker: string } = { head: HEAD_ID, worker: WORKER_ID },
): {
  deps: Pick<
    ManagedClusterVllmLifecycleDeps,
    "inspectNode" | "removeContainer" | "withLifecycleLock"
  >;
  removeContainer: ReturnType<typeof vi.fn>;
} {
  const removeContainer = vi.fn(async () => ({ ok: true as const }));
  return {
    deps: {
      inspectNode: async (rolePlan) =>
        rolePlan.role === "head"
          ? snapshot(runtimePlan.roles[0], ids.head)
          : snapshot(runtimePlan.roles[1], ids.worker),
      removeContainer,
      withLifecycleLock: async (_plan, operation) => await operation(),
    },
    removeContainer,
  };
}

describe("managed cluster vLLM runtime receipt", () => {
  it("uses the host-global default gateway state root", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();
    const { managedClusterVllmRuntimeReceiptPath: selectedReceiptPath } = await import(
      "./serving/managed-cluster-runtime-receipt"
    );
    expect(selectedReceiptPath()).toBe(
      path.join(os.homedir(), ".nemoclaw", "managed-cluster-vllm-runtime.json"),
    );
  });

  it("persists a private exact runtime plan with a promoted SSH binding and no bearer key", () => {
    const source = input();
    const runtime = persistManagedClusterVllmRuntimeReceipt(source, { stateDir });
    const receiptPath = managedClusterVllmRuntimeReceiptPath(stateDir);
    const raw = fs.readFileSync(receiptPath, "utf8");
    const worker = runtime.nodes.find((node) => node.binding)!;

    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(`${receiptPath}.rank-1.ssh-binding`).isDirectory()).toBe(true);
    expect(raw).not.toContain(API_KEY);
    expect(worker.sshBinding).not.toBe(sshFixture.token);
    expect(runtime.plan.roles[1].execution).toMatchObject({
      kind: "ssh",
      expectedTarget: sshFixture.binding.peerTarget,
      bindingHandle: worker.sshBinding,
    });
    expect(worker.binding?.bindingFile).toContain(`${receiptPath}.rank-1.ssh-binding/`);
    expect(loadManagedClusterVllmRuntimeReceipt({ stateDir })).toEqual(runtime);
  });

  it("is idempotent only for the same committed runtime", () => {
    const source = input();
    const first = persistManagedClusterVllmRuntimeReceipt(source, { stateDir });
    const receiptPath = managedClusterVllmRuntimeReceiptPath(stateDir);
    const original = fs.readFileSync(receiptPath, "utf8");

    expect(persistManagedClusterVllmRuntimeReceipt(source, { stateDir })).toEqual(first);
    expect(() =>
      persistManagedClusterVllmRuntimeReceipt(
        {
          ...source,
          nodes: source.nodes.map((node) =>
            node.nodeId === source.plan.roles[1]?.nodeId
              ? { ...node, containerId: "e".repeat(64) }
              : node,
          ),
        },
        { stateDir },
      ),
    ).toThrow("different managed cluster runtime receipt");
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(original);
  });

  it("keeps a selected profile receipt valid when unrelated catalog entries change", async () => {
    const source = input();
    const currentCatalog = loadManagedInferenceCatalog();
    const changedCatalog = catalogWithUnrelatedProfile();
    persistManagedClusterVllmRuntimeReceipt(source, { stateDir });

    expect(changedCatalog.catalogDigest).not.toBe(currentCatalog.catalogDigest);
    vi.doMock("./serving/generated/catalog.json", () => ({ default: changedCatalog }));
    vi.resetModules();
    const { loadManagedClusterVllmRuntimeReceipt: loadAgainstChangedCatalog } = await import(
      "./serving/managed-cluster-runtime-receipt"
    );
    const loaded = loadAgainstChangedCatalog({ stateDir });
    const currentPreset = changedCatalog.presets.find(
      ({ definition }) => definition.metadata.id === source.plan.presetId,
    );
    const currentRecipe = changedCatalog.recipes.find(
      ({ definition }) => definition.metadata.id === source.plan.recipeId,
    );

    expect(loaded?.plan.catalogDigest).toBe(currentCatalog.catalogDigest);
    expect(loaded?.plan.presetDigest).toBe(currentPreset?.definitionDigest);
    expect(loaded?.plan.recipeDigest).toBe(currentRecipe?.definitionDigest);
  });

  it("preserves a receipt-write failure when temporary-file cleanup also fails", () => {
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("receipt rename failed");
    });
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw new Error("temporary cleanup failed");
    });

    expect(() => persistManagedClusterVllmRuntimeReceipt(input(), { stateDir })).toThrow(
      "receipt rename failed",
    );
    expect(rename).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledOnce();
  });

  it("refuses a pre-existing SSH binding tree without mutating it", () => {
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const receiptPath = managedClusterVllmRuntimeReceiptPath(stateDir);
    const bindingPath = `${receiptPath}.rank-1.ssh-binding`;
    const markerPath = path.join(bindingPath, "foreign-state");
    fs.mkdirSync(bindingPath, { mode: 0o700 });
    fs.writeFileSync(markerPath, "leave intact\n", { mode: 0o600 });

    expect(() => persistManagedClusterVllmRuntimeReceipt(input(), { stateDir })).toThrow(
      "Managed cluster SSH binding state already exists",
    );
    expect(fs.readFileSync(markerPath, "utf8")).toBe("leave intact\n");
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  it("refuses a symbolic-link receipt", () => {
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const target = path.join(root, "redirected.json");
    fs.writeFileSync(target, "{}\n", { mode: 0o600 });
    fs.symlinkSync(target, managedClusterVllmRuntimeReceiptPath(stateDir));

    expect(() => loadManagedClusterVllmRuntimeReceipt({ stateDir })).toThrow("symbolic link");
  });

  it("rejects changed plan contents before using the persisted binding", () => {
    persistManagedClusterVllmRuntimeReceipt(input(), { stateDir });
    const receiptPath = managedClusterVllmRuntimeReceiptPath(stateDir);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.plan.model.id = "foreign/model";
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
      mode: 0o600,
    });

    expect(() => loadManagedClusterVllmRuntimeReceipt({ stateDir })).toThrow("plan digest changed");
  });

  it("recovers only the exact healthy receipt-owned endpoint synchronously", () => {
    const runtime = persistManagedClusterVllmRuntimeReceipt(input(), { stateDir });
    expect(
      recoverInstalledManagedClusterVllmEndpoint({
        stateDir,
        loadApiKey: () => API_KEY,
        inspectNodesSync: () => ({
          nodes: runtime.plan.roles.map((rolePlan) => ({
            nodeId: rolePlan.nodeId,
            snapshot: snapshot(rolePlan, rolePlan.rank === 0 ? HEAD_ID : WORKER_ID),
          })),
        }),
      }),
    ).toEqual({
      baseUrl: runtime.plan.roles[0].endpoint,
      apiKey: API_KEY,
      apiKeyFingerprint: runtime.apiKeyFingerprint,
      plan: runtime.plan,
    });
  });

  it("signals a managed endpoint whose exact receipt-owned IDs changed", () => {
    const runtime = persistManagedClusterVllmRuntimeReceipt(input(), { stateDir });
    expect(() =>
      recoverInstalledManagedClusterVllmEndpoint({
        stateDir,
        loadApiKey: () => API_KEY,
        inspectNodesSync: () => ({
          nodes: runtime.plan.roles.map((rolePlan) => ({
            nodeId: rolePlan.nodeId,
            snapshot: snapshot(rolePlan, rolePlan.rank === 0 ? "e".repeat(64) : WORKER_ID),
          })),
        }),
      }),
    ).toThrow("not recoverable");
  });

  it("signals a persisted managed endpoint whose key no longer matches", () => {
    persistManagedClusterVllmRuntimeReceipt(input(), { stateDir });
    expect(() =>
      recoverInstalledManagedClusterVllmEndpoint({
        stateDir,
        loadApiKey: () => "f".repeat(64),
        inspectNodesSync: vi.fn(),
      }),
    ).toThrow("API key no longer matches");
  });

  it("removes only both exact receipt-owned containers before retiring state", async () => {
    const { discoveryStatePath, runtime } = persistWithDiscoveryBinding();
    const { deps, removeContainer } = cleanupDeps(runtime.plan);
    await expect(
      cleanupInstalledManagedClusterVllmRuntime({
        stateDir,
        loadApiKey: () => API_KEY,
        createLifecycleDeps: () => deps,
      }),
    ).resolves.toEqual({
      kind: "removed",
      removedContainerIds: [HEAD_ID, WORKER_ID],
    });
    expect(removeContainer).toHaveBeenNthCalledWith(1, runtime.plan.roles[0], HEAD_ID);
    expect(removeContainer).toHaveBeenNthCalledWith(2, runtime.plan.roles[1], WORKER_ID);
    expect(fs.existsSync(`${discoveryStatePath}.ssh-binding`)).toBe(false);
    expect(fs.existsSync(managedClusterVllmRuntimeReceiptPath(stateDir))).toBe(false);
    expect(
      fs.existsSync(`${managedClusterVllmRuntimeReceiptPath(stateDir)}.rank-1.ssh-binding`),
    ).toBe(false);
  });

  it("preserves a replaced canonical discovery binding before container cleanup", async () => {
    const { discoveryBindingPath, discoveryStatePath, runtime } = persistWithDiscoveryBinding();
    clearDualStationSshBinding(discoveryStatePath);
    copyDualStationSshBinding(discoveryStatePath, sshFixture.binding);
    const { deps, removeContainer } = cleanupDeps(runtime.plan);
    const createLifecycleDeps = vi.fn(() => deps);

    await expect(
      cleanupInstalledManagedClusterVllmRuntime({
        stateDir,
        loadApiKey: () => API_KEY,
        createLifecycleDeps,
      }),
    ).rejects.toThrow("does not match the runtime receipt identity");

    expect(createLifecycleDeps).not.toHaveBeenCalled();
    expect(removeContainer).not.toHaveBeenCalled();
    expect(fs.existsSync(discoveryBindingPath)).toBe(true);
    expect(fs.existsSync(managedClusterVllmRuntimeReceiptPath(stateDir))).toBe(true);
    expect(
      fs.existsSync(`${managedClusterVllmRuntimeReceiptPath(stateDir)}.rank-1.ssh-binding`),
    ).toBe(true);
  });

  it("retains durable ownership when a leftover discovery binding is unsafe to retire", async () => {
    const { discoveryBindingPath, runtime } = persistWithDiscoveryBinding();
    const snapshots: Record<"head" | "worker", ManagedClusterNodeSnapshot> = {
      head: snapshot(runtime.plan.roles[0], HEAD_ID),
      worker: snapshot(runtime.plan.roles[1], WORKER_ID),
    };
    const discoveryBindingModeByRole: Record<ManagedClusterVllmRolePlan["role"], number> = {
      head: 0o700,
      worker: 0o755,
    };
    const removeContainer = vi.fn(async (rolePlan: ManagedClusterVllmRolePlan, id: string) => {
      snapshots[rolePlan.role] = {
        ...snapshots[rolePlan.role],
        containers: snapshots[rolePlan.role].containers.filter((container) => container.id !== id),
      };
      fs.chmodSync(discoveryBindingPath, discoveryBindingModeByRole[rolePlan.role]);
      return { ok: true as const };
    });
    const options = {
      stateDir,
      loadApiKey: () => API_KEY,
      createLifecycleDeps: () => ({
        inspectNode: async (rolePlan: ManagedClusterVllmRolePlan) => snapshots[rolePlan.role],
        removeContainer,
        withLifecycleLock: async <T>(_plan: ManagedClusterVllmPlan, operation: () => Promise<T>) =>
          await operation(),
      }),
    };

    await expect(cleanupInstalledManagedClusterVllmRuntime(options)).rejects.toThrow(
      "must be an owner-only directory",
    );

    expect(removeContainer).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(discoveryBindingPath)).toBe(true);
    expect(fs.existsSync(managedClusterVllmRuntimeReceiptPath(stateDir))).toBe(true);
    expect(
      fs.existsSync(`${managedClusterVllmRuntimeReceiptPath(stateDir)}.rank-1.ssh-binding`),
    ).toBe(true);

    fs.chmodSync(discoveryBindingPath, 0o700);
    await expect(cleanupInstalledManagedClusterVllmRuntime(options)).resolves.toEqual({
      kind: "removed",
      removedContainerIds: [],
    });
    expect(removeContainer).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(discoveryBindingPath)).toBe(false);
    expect(fs.existsSync(managedClusterVllmRuntimeReceiptPath(stateDir))).toBe(false);
    expect(
      fs.existsSync(`${managedClusterVllmRuntimeReceiptPath(stateDir)}.rank-1.ssh-binding`),
    ).toBe(false);
  });

  it("retains the receipt and resumes after one exact container removal fails", async () => {
    const { discoveryStatePath, runtime } = persistWithDiscoveryBinding();
    const snapshots: Record<"head" | "worker", ManagedClusterNodeSnapshot> = {
      head: snapshot(runtime.plan.roles[0], HEAD_ID),
      worker: snapshot(runtime.plan.roles[1], WORKER_ID),
    };
    let workerAttempts = 0;
    const removeContainer = vi.fn(async (rolePlan: ManagedClusterVllmRolePlan, id: string) => {
      const shouldFailWorker = rolePlan.role === "worker" && workerAttempts === 0;
      workerAttempts += Number(rolePlan.role === "worker");
      const removeOwnedContainer = () => {
        snapshots[rolePlan.role] = {
          ...snapshots[rolePlan.role],
          containers: snapshots[rolePlan.role].containers.filter(
            (container) => container.id !== id,
          ),
        };
        return { ok: true as const };
      };
      return shouldFailWorker
        ? ({
            ok: false as const,
            reason: "worker daemon unavailable",
          } as const)
        : removeOwnedContainer();
    });
    const deps = {
      inspectNode: async (rolePlan: ManagedClusterVllmRolePlan) => snapshots[rolePlan.role],
      removeContainer,
      withLifecycleLock: async <T>(_plan: ManagedClusterVllmPlan, operation: () => Promise<T>) =>
        await operation(),
    };
    const options = {
      stateDir,
      loadApiKey: () => API_KEY,
      createLifecycleDeps: () => deps,
    };

    await expect(cleanupInstalledManagedClusterVllmRuntime(options)).rejects.toThrow(
      "worker daemon unavailable",
    );
    expect(fs.existsSync(`${discoveryStatePath}.ssh-binding`)).toBe(true);
    expect(fs.existsSync(managedClusterVllmRuntimeReceiptPath(stateDir))).toBe(true);
    await expect(cleanupInstalledManagedClusterVllmRuntime(options)).resolves.toEqual({
      kind: "removed",
      removedContainerIds: [WORKER_ID],
    });
    expect(removeContainer.mock.calls.map((call) => call[1])).toEqual([
      HEAD_ID,
      WORKER_ID,
      WORKER_ID,
    ]);
    expect(fs.existsSync(`${discoveryStatePath}.ssh-binding`)).toBe(false);
    expect(fs.existsSync(managedClusterVllmRuntimeReceiptPath(stateDir))).toBe(false);
  });

  it("preserves recovery state when the observed container IDs changed", async () => {
    const runtime = persistManagedClusterVllmRuntimeReceipt(input(), { stateDir });
    const { deps, removeContainer } = cleanupDeps(runtime.plan, {
      head: "e".repeat(64),
      worker: WORKER_ID,
    });
    await expect(
      cleanupInstalledManagedClusterVllmRuntime({
        stateDir,
        loadApiKey: () => API_KEY,
        createLifecycleDeps: () => deps,
      }),
    ).rejects.toThrow("head receipt-owned container is absent but related runtime state exists");
    expect(removeContainer).not.toHaveBeenCalled();
    expect(fs.existsSync(managedClusterVllmRuntimeReceiptPath(stateDir))).toBe(true);
    expect(
      fs.existsSync(`${managedClusterVllmRuntimeReceiptPath(stateDir)}.rank-1.ssh-binding`),
    ).toBe(true);
  });

  it("preserves recovery state when the managed API key changed", async () => {
    persistManagedClusterVllmRuntimeReceipt(input(), { stateDir });
    const createLifecycleDeps = vi.fn();
    await expect(
      cleanupInstalledManagedClusterVllmRuntime({
        stateDir,
        loadApiKey: () => "f".repeat(64),
        createLifecycleDeps,
      }),
    ).rejects.toThrow("API key no longer matches");
    expect(createLifecycleDeps).not.toHaveBeenCalled();
    expect(fs.existsSync(managedClusterVllmRuntimeReceiptPath(stateDir))).toBe(true);
  });

  it("does nothing when no runtime receipt exists", async () => {
    await expect(
      cleanupInstalledManagedClusterVllmRuntime({
        stateDir,
        loadApiKey: vi.fn(),
        createLifecycleDeps: vi.fn(),
      }),
    ).resolves.toEqual({ kind: "not-installed" });
  });
});
