// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadManagedInferenceCatalog } from "./serving/catalog";
import { fixtureDualSparkSelection } from "./serving/dual-spark-fixture.test-support";
import {
  type DualSparkNodeSnapshot,
  type DualSparkVllmLifecycleDeps,
  dualSparkVllmApiKeyFingerprint,
} from "./serving/dual-spark-lifecycle";
import {
  DUAL_SPARK_API_KEY_FINGERPRINT_LABEL,
  DUAL_SPARK_TRANSACTION_LABEL,
  type DualSparkVllmPlan,
  type DualSparkVllmRolePlan,
  materializeDualSparkVllmPlan,
} from "./serving/dual-spark-materialize";
import { dualSparkTopologyOutputDigest } from "./serving/dual-spark-topology";
import {
  cleanupInstalledDualSparkVllmRuntime,
  dualSparkVllmRuntimeReceiptPath,
  loadDualSparkVllmRuntimeReceipt,
  type PersistDualSparkVllmRuntimeReceiptInput,
  persistDualSparkVllmRuntimeReceipt,
  recoverInstalledDualSparkVllmEndpoint,
} from "./serving/spark-runtime-receipt";
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-spark-runtime-receipt-"));
  stateDir = path.join(root, ".nemoclaw");
  sshFixture = createDualStationSshBindingFixture("nvidia@spark-worker.local");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  sshFixture.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

function plan(): DualSparkVllmPlan {
  const selection = fixtureDualSparkSelection();
  const catalog = loadManagedInferenceCatalog();
  const sourceTopology = selection.topologyQualification;
  const output = {
    ...sourceTopology.output,
    peer: {
      target: sshFixture.binding.peerTarget,
      sshBindingHandle: sshFixture.token,
    },
  };
  return materializeDualSparkVllmPlan({
    ...selection,
    catalogDigest: catalog.catalogDigest,
    preset: catalog.presets[0]!.definition,
    recipe: catalog.recipes[0]!.definition,
    topologyQualification: {
      ...sourceTopology,
      outputDigest: dualSparkTopologyOutputDigest(output),
      output,
    },
  });
}

function input(): PersistDualSparkVllmRuntimeReceiptInput {
  return {
    plan: plan(),
    peerSshBinding: sshFixture.binding,
    localCacheRoot: "/home/nvidia/.cache/huggingface",
    peerCacheRoot: "/home/nvidia/.cache/huggingface",
    apiKeyFingerprint: dualSparkVllmApiKeyFingerprint(API_KEY),
    headContainerId: HEAD_ID,
    workerContainerId: WORKER_ID,
  };
}

function snapshot(rolePlan: DualSparkVllmRolePlan, containerId: string): DualSparkNodeSnapshot {
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
          [DUAL_SPARK_API_KEY_FINGERPRINT_LABEL]: dualSparkVllmApiKeyFingerprint(API_KEY),
          [DUAL_SPARK_TRANSACTION_LABEL]: TRANSACTION_ID,
        },
      },
    ],
    listeningPorts:
      rolePlan.role === "head" ? [rolePlan.endpoint ? 8000 : 0, 25000].filter(Boolean) : [25000],
  };
}

function cleanupDeps(
  runtimePlan: DualSparkVllmPlan,
  ids: { head: string; worker: string } = { head: HEAD_ID, worker: WORKER_ID },
): {
  deps: Pick<DualSparkVllmLifecycleDeps, "inspectNode" | "removeContainer" | "withLifecycleLock">;
  removeContainer: ReturnType<typeof vi.fn>;
} {
  const removeContainer = vi.fn(async () => ({ ok: true as const }));
  return {
    deps: {
      inspectNode: async (rolePlan) =>
        rolePlan.role === "head"
          ? snapshot(runtimePlan.roles.head, ids.head)
          : snapshot(runtimePlan.roles.worker, ids.worker),
      removeContainer,
      withLifecycleLock: async (_plan, operation) => await operation(),
    },
    removeContainer,
  };
}

describe("dual-Spark vLLM runtime receipt", () => {
  it("uses the host-global default gateway state root", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();
    const { dualSparkVllmRuntimeReceiptPath: selectedReceiptPath } = await import(
      "./serving/spark-runtime-receipt"
    );
    expect(selectedReceiptPath()).toBe(
      path.join(os.homedir(), ".nemoclaw", "dual-spark-vllm-runtime.json"),
    );
  });

  it("persists a private exact runtime plan with a promoted SSH binding and no bearer key", () => {
    const source = input();
    const runtime = persistDualSparkVllmRuntimeReceipt(source, { stateDir });
    const receiptPath = dualSparkVllmRuntimeReceiptPath(stateDir);
    const raw = fs.readFileSync(receiptPath, "utf8");

    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(`${receiptPath}.ssh-binding`).isDirectory()).toBe(true);
    expect(raw).not.toContain(API_KEY);
    expect(runtime.sshBinding).not.toBe(sshFixture.token);
    expect(runtime.plan.roles.worker.execution).toMatchObject({
      kind: "ssh",
      expectedTarget: sshFixture.binding.peerTarget,
      bindingHandle: runtime.sshBinding,
    });
    expect(runtime.peerSshBinding.bindingFile).toContain(`${receiptPath}.ssh-binding/`);
    expect(loadDualSparkVllmRuntimeReceipt({ stateDir })).toEqual(runtime);
  });

  it("is idempotent only for the same committed runtime", () => {
    const source = input();
    const first = persistDualSparkVllmRuntimeReceipt(source, { stateDir });
    const receiptPath = dualSparkVllmRuntimeReceiptPath(stateDir);
    const original = fs.readFileSync(receiptPath, "utf8");

    expect(persistDualSparkVllmRuntimeReceipt(source, { stateDir })).toEqual(first);
    expect(() =>
      persistDualSparkVllmRuntimeReceipt(
        { ...source, workerContainerId: "e".repeat(64) },
        { stateDir },
      ),
    ).toThrow("different managed dual-Spark runtime receipt");
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(original);
  });

  it("refuses a pre-existing SSH binding tree without mutating it", () => {
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const receiptPath = dualSparkVllmRuntimeReceiptPath(stateDir);
    const bindingPath = `${receiptPath}.ssh-binding`;
    const markerPath = path.join(bindingPath, "foreign-state");
    fs.mkdirSync(bindingPath, { mode: 0o700 });
    fs.writeFileSync(markerPath, "leave intact\n", { mode: 0o600 });

    expect(() => persistDualSparkVllmRuntimeReceipt(input(), { stateDir })).toThrow(
      "Managed dual-Spark SSH binding state already exists",
    );
    expect(fs.readFileSync(markerPath, "utf8")).toBe("leave intact\n");
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  it("refuses a symbolic-link receipt", () => {
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const target = path.join(root, "redirected.json");
    fs.writeFileSync(target, "{}\n", { mode: 0o600 });
    fs.symlinkSync(target, dualSparkVllmRuntimeReceiptPath(stateDir));

    expect(() => loadDualSparkVllmRuntimeReceipt({ stateDir })).toThrow("symbolic link");
  });

  it("rejects changed plan contents before using the persisted binding", () => {
    persistDualSparkVllmRuntimeReceipt(input(), { stateDir });
    const receiptPath = dualSparkVllmRuntimeReceiptPath(stateDir);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.plan.model.id = "foreign/model";
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });

    expect(() => loadDualSparkVllmRuntimeReceipt({ stateDir })).toThrow("plan digest changed");
  });

  it("recovers only the exact healthy receipt-owned endpoint synchronously", () => {
    const runtime = persistDualSparkVllmRuntimeReceipt(input(), { stateDir });
    expect(
      recoverInstalledDualSparkVllmEndpoint({
        stateDir,
        loadApiKey: () => API_KEY,
        inspectNodesSync: () => ({
          head: snapshot(runtime.plan.roles.head, HEAD_ID),
          worker: snapshot(runtime.plan.roles.worker, WORKER_ID),
        }),
      }),
    ).toEqual({
      baseUrl: runtime.plan.roles.head.endpoint,
      apiKey: API_KEY,
      apiKeyFingerprint: runtime.apiKeyFingerprint,
      plan: runtime.plan,
    });
  });

  it("signals a managed endpoint whose exact receipt-owned IDs changed", () => {
    const runtime = persistDualSparkVllmRuntimeReceipt(input(), { stateDir });
    expect(() =>
      recoverInstalledDualSparkVllmEndpoint({
        stateDir,
        loadApiKey: () => API_KEY,
        inspectNodesSync: () => ({
          head: snapshot(runtime.plan.roles.head, "e".repeat(64)),
          worker: snapshot(runtime.plan.roles.worker, WORKER_ID),
        }),
      }),
    ).toThrow("not recoverable");
  });

  it("signals a persisted managed endpoint whose key no longer matches", () => {
    persistDualSparkVllmRuntimeReceipt(input(), { stateDir });
    expect(() =>
      recoverInstalledDualSparkVllmEndpoint({
        stateDir,
        loadApiKey: () => "f".repeat(64),
        inspectNodesSync: vi.fn(),
      }),
    ).toThrow("API key no longer matches");
  });

  it("removes only both exact receipt-owned containers before retiring state", async () => {
    const runtime = persistDualSparkVllmRuntimeReceipt(input(), { stateDir });
    const { deps, removeContainer } = cleanupDeps(runtime.plan);
    await expect(
      cleanupInstalledDualSparkVllmRuntime({
        stateDir,
        loadApiKey: () => API_KEY,
        createLifecycleDeps: () => deps,
      }),
    ).resolves.toEqual({ kind: "removed", removedContainerIds: [HEAD_ID, WORKER_ID] });
    expect(removeContainer).toHaveBeenNthCalledWith(1, runtime.plan.roles.head, HEAD_ID);
    expect(removeContainer).toHaveBeenNthCalledWith(2, runtime.plan.roles.worker, WORKER_ID);
    expect(fs.existsSync(dualSparkVllmRuntimeReceiptPath(stateDir))).toBe(false);
    expect(fs.existsSync(`${dualSparkVllmRuntimeReceiptPath(stateDir)}.ssh-binding`)).toBe(false);
  });

  it("retains the receipt and resumes after one exact container removal fails", async () => {
    const runtime = persistDualSparkVllmRuntimeReceipt(input(), { stateDir });
    const snapshots: Record<"head" | "worker", DualSparkNodeSnapshot> = {
      head: snapshot(runtime.plan.roles.head, HEAD_ID),
      worker: snapshot(runtime.plan.roles.worker, WORKER_ID),
    };
    let workerAttempts = 0;
    const removeContainer = vi.fn(async (rolePlan: DualSparkVllmRolePlan, id: string) => {
      if (rolePlan.role === "worker" && workerAttempts++ === 0) {
        return { ok: false as const, reason: "worker daemon unavailable" };
      }
      snapshots[rolePlan.role] = {
        ...snapshots[rolePlan.role],
        containers: snapshots[rolePlan.role].containers.filter((container) => container.id !== id),
      };
      return { ok: true as const };
    });
    const deps = {
      inspectNode: async (rolePlan: DualSparkVllmRolePlan) => snapshots[rolePlan.role],
      removeContainer,
      withLifecycleLock: async <T>(_plan: DualSparkVllmPlan, operation: () => Promise<T>) =>
        await operation(),
    };
    const options = {
      stateDir,
      loadApiKey: () => API_KEY,
      createLifecycleDeps: () => deps,
    };

    await expect(cleanupInstalledDualSparkVllmRuntime(options)).rejects.toThrow(
      "worker daemon unavailable",
    );
    expect(fs.existsSync(dualSparkVllmRuntimeReceiptPath(stateDir))).toBe(true);
    await expect(cleanupInstalledDualSparkVllmRuntime(options)).resolves.toEqual({
      kind: "removed",
      removedContainerIds: [WORKER_ID],
    });
    expect(removeContainer.mock.calls.map((call) => call[1])).toEqual([
      HEAD_ID,
      WORKER_ID,
      WORKER_ID,
    ]);
    expect(fs.existsSync(dualSparkVllmRuntimeReceiptPath(stateDir))).toBe(false);
  });

  it("preserves recovery state when the observed container IDs changed", async () => {
    const runtime = persistDualSparkVllmRuntimeReceipt(input(), { stateDir });
    const { deps, removeContainer } = cleanupDeps(runtime.plan, {
      head: "e".repeat(64),
      worker: WORKER_ID,
    });
    await expect(
      cleanupInstalledDualSparkVllmRuntime({
        stateDir,
        loadApiKey: () => API_KEY,
        createLifecycleDeps: () => deps,
      }),
    ).rejects.toThrow("head receipt-owned container is absent but related runtime state exists");
    expect(removeContainer).not.toHaveBeenCalled();
    expect(fs.existsSync(dualSparkVllmRuntimeReceiptPath(stateDir))).toBe(true);
    expect(fs.existsSync(`${dualSparkVllmRuntimeReceiptPath(stateDir)}.ssh-binding`)).toBe(true);
  });

  it("preserves recovery state when the managed API key changed", async () => {
    persistDualSparkVllmRuntimeReceipt(input(), { stateDir });
    const createLifecycleDeps = vi.fn();
    await expect(
      cleanupInstalledDualSparkVllmRuntime({
        stateDir,
        loadApiKey: () => "f".repeat(64),
        createLifecycleDeps,
      }),
    ).rejects.toThrow("API key no longer matches");
    expect(createLifecycleDeps).not.toHaveBeenCalled();
    expect(fs.existsSync(dualSparkVllmRuntimeReceiptPath(stateDir))).toBe(true);
  });

  it("does nothing when no runtime receipt exists", async () => {
    await expect(
      cleanupInstalledDualSparkVllmRuntime({
        stateDir,
        loadApiKey: vi.fn(),
        createLifecycleDeps: vi.fn(),
      }),
    ).resolves.toEqual({ kind: "not-installed" });
  });
});
