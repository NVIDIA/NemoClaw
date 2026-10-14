// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { createHostLocalCreateJournalStore } from "../../onboard/runtime-provider/host-local-create-journal";
import { dockerLlamaCppBindingSha256 } from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceReceipt,
  HostLocalLlamaCppLifecycle,
} from "../../onboard/runtime-provider/host-local-inference";
import { isLlamaCppServingRecipe } from "../serving/adapter-registry";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ResolvedLlamaCppInferenceSelection } from "../serving/types";
import {
  installManagedLlamaCpp,
  rehydrateManagedLlamaCppLifecycle,
  requireStationGb300StartupGpuAuthority,
  resumeManagedLlamaCppRuntime,
  selectStationGb300GpuUuid,
} from "./managed-installer";
import { engineHarness } from "./managed-installer.test-support";
import {
  createManagedLlamaCppReceiptWriter,
  loadManagedLlamaCppOwner,
  loadOrCreateManagedLlamaCppApiKey,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "./managed-state";
import { serializeHostLocalInferenceReceipt } from "../../onboard/runtime-provider/host-local-inference";

const uuid = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1";
const gpu = {
  type: "nvidia" as const,
  count: 2,
  totalMemoryMB: 281170,
  perGpuMB: 24467,
  nimCapable: true,
  containerGpuProof: { providerId: "docker" as const, passed: true as const },
  provedGpuDevices: [
    {
      uuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee0",
      name: "NVIDIA RTX PRO 4000 Blackwell",
      totalMemoryMB: 24467,
      availableMemoryMB: 24000,
    },
    {
      uuid,
      name: "NVIDIA GB300",
      totalMemoryMB: 256703,
      availableMemoryMB: 250000,
    },
  ],
};

function stationSelection(): ResolvedLlamaCppInferenceSelection {
  const catalog = loadManagedInferenceCatalog();
  const preset = catalog.presets.find(
    ({ metadata }) => metadata.id === "llama-cpp.station-gb300-wsl-arm64.single.qwen3-6-35b-a3b",
  )!;
  const recipe = catalog.recipes.find(
    ({ metadata }) => metadata.id === preset.spec.plan.recipeRef,
  )!;
  expect(isLlamaCppServingRecipe(recipe)).toBe(true);
  return {
    outcome: "selected",
    selection: "automatic",
    catalogDigest: catalog.catalogDigest,
    presetDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingPreset" && id === preset.metadata.id,
    )!.digest,
    recipeDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingRecipe" && id === recipe.metadata.id,
    )!.digest,
    preset,
    recipe: recipe as ResolvedLlamaCppInferenceSelection["recipe"],
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("Station managed llama.cpp GPU binding (#13026)", () => {
  it("selects the unique Docker-proved GB300 and rejects missing or ambiguous evidence", () => {
    const selected = stationSelection();
    expect(selectStationGb300GpuUuid(selected, gpu)).toBe(uuid);
    expect(() => selectStationGb300GpuUuid(selected, { ...gpu, provedGpuDevices: [] })).toThrow(
      "exactly one proved GB300 GPU UUID",
    );
    expect(() =>
      selectStationGb300GpuUuid(selected, {
        ...gpu,
        provedGpuDevices: [...gpu.provedGpuDevices, gpu.provedGpuDevices[1]!],
      }),
    ).toThrow("exactly one proved GB300 GPU UUID");
    expect(() =>
      selectStationGb300GpuUuid(selected, {
        ...gpu,
        containerGpuProof: { providerId: "podman", passed: true },
      }),
    ).toThrow("Docker-bound CUDA proof");
  });

  function setup(selected: ResolvedLlamaCppInferenceSelection) {
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-")));
    const executableRoot = path.join(homeDir, "bin");
    fs.mkdirSync(executableRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(executableRoot, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    vi.stubEnv("PATH", executableRoot);
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const receipt = { schemaVersion: 1 } as HostLocalInferenceReceipt;
    const createLifecycle = vi.fn(() => ({
      recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
      resume: vi.fn(() => receipt),
      runtime: {} as HostLocalLlamaCppLifecycle["runtime"],
      start: vi.fn(() => receipt),
    }));
    const operation = {
      providerId: "docker" as const,
      engine: harness.engine,
      bindingSha256: dockerLlamaCppBindingSha256(harness.engine),
      assertAuthority: vi.fn(),
      spawn: vi.fn(() => ({}) as never),
      createLlamaCppLifecycle: createLifecycle,
    } as HostLocalInferenceOperation;
    const provider = createDockerRuntimeProviderBundle();
    const runtimeProvider = {
      ...provider,
      hostLocalInference: {
        providerId: "docker" as const,
        supported: true as const,
        services: ["llama-cpp" as const],
        createOperation: vi.fn(() => operation),
      },
    };
    const hostPath = path.join(homeDir, "model.gguf");
    fs.writeFileSync(hostPath, "fixture", { mode: 0o600 });
    const identity = fs.lstatSync(hostPath, { bigint: true });
    const verifyGguf = vi.fn(async () => ({
      digest: selected.recipe.spec.model.files[0]!.digest,
      filesystemIdentity: {
        ctimeNs: identity.ctimeNs,
        dev: identity.dev,
        ino: identity.ino,
        mtimeNs: identity.mtimeNs,
        size: identity.size,
      },
      hostPath,
      sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
    }));
    const install = () =>
      installManagedLlamaCpp(selected, {
        sandboxName: "station-agent",
        homeDir,
        runtimeProvider,
        gpu,
        verifyGguf,
        checkPort: vi.fn(async () => ({ ok: true })),
        log: vi.fn(),
      });
    const legacyOwner = () => ({
      schemaVersion: 1 as const,
      sandboxName: "station-agent",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    return {
      homeDir,
      createLifecycle,
      install,
      legacyOwner,
      runtimeProvider,
      operation,
      verifyGguf,
    };
  }

  function seedLegacyRuntimeAuthority(
    selected: ResolvedLlamaCppInferenceSelection,
    homeDir: string,
    engine: ReturnType<typeof engineHarness>["engine"],
  ): void {
    const paths = managedLlamaCppStatePaths(homeDir);
    const transactionId = "a".repeat(64);
    const engineAuthority = {
      schemaVersion: 1 as const,
      providerId: "docker",
      operation: "host-local-inference" as const,
      engineId: engine.engineId,
      authorityId: engine.authorityId,
      bindingSha256: dockerLlamaCppBindingSha256(engine),
    };
    const receipt = {
      schemaVersion: 1,
      providerId: "docker",
      service: "llama-cpp",
      engineAuthority,
      endpoint: {
        host: "host.openshell.internal",
        port: 8081,
        networkName: "nemoclaw-llama-cpp",
      },
      runtime: {
        kind: "container",
        runtimeId: "b".repeat(64),
        name: "nemoclaw-llama-cpp",
        imageRef: selected.recipe.spec.runtime.image,
        probeImageRef: selected.recipe.spec.readiness.probeImage,
        specSha256: "c".repeat(64),
        model: {
          planDigest: `sha256:${"d".repeat(64)}`,
          recipeId: selected.recipe.metadata.id,
          generation: transactionId,
          digest: selected.recipe.spec.model.files[0]!.digest,
          sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
        },
        gpu: { vendor: "nvidia", count: 1 },
      },
    } as const satisfies HostLocalInferenceReceipt;
    createManagedLlamaCppReceiptWriter(paths, transactionId).writeExact(
      serializeHostLocalInferenceReceipt(receipt),
    );
  }

  function seedLegacyUnfinishedJournal(
    homeDir: string,
    engine: ReturnType<typeof engineHarness>["engine"],
  ): void {
    const paths = managedLlamaCppStatePaths(homeDir);
    const transactionId = "a".repeat(64);
    createHostLocalCreateJournalStore(paths.stateDir).create({
      schemaVersion: 1,
      transactionId,
      phase: "prepared",
      providerId: "docker",
      service: "llama-cpp",
      containerName: "nemoclaw-llama-cpp",
      runtimeId: null,
      createIntentUnixMs: null,
      specSha256: "c".repeat(64),
      networkId: "e".repeat(64),
      apiKeyIdentitySha256: "f".repeat(64),
      apiKeyRootIdentitySha256: "1".repeat(64),
      engineAuthority: {
        schemaVersion: 1,
        providerId: "docker",
        operation: "host-local-inference",
        engineId: engine.engineId,
        authorityId: engine.authorityId,
        bindingSha256: dockerLlamaCppBindingSha256(engine),
      },
      receiptTargetSha256: createManagedLlamaCppReceiptWriter(paths, transactionId).targetSha256,
      serializedReceipt: null,
      receiptSha256: null,
    });
  }

  it("persists the proved UUID in lifecycle authority", async () => {
    const selected = stationSelection();
    const fixture = setup(selected);
    try {
      const result = await fixture.install();
      expect(result.ok).toBe(true);
      expect(
        loadManagedLlamaCppOwner(managedLlamaCppStatePaths(fixture.homeDir))?.gpuDeviceUuid,
      ).toBe(uuid);
      expect(fixture.createLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          bindings: expect.objectContaining({ gpuDeviceUuid: uuid }),
        }),
      );
    } finally {
      fs.rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  it("binds a legacy Station owner to the proved UUID on retry when no runtime authority exists", async () => {
    const selected = stationSelection();
    const fixture = setup(selected);
    try {
      const paths = managedLlamaCppStatePaths(fixture.homeDir);
      reserveManagedLlamaCppOwner(paths, fixture.legacyOwner());
      expect((await fixture.install()).ok).toBe(true);
      expect(loadManagedLlamaCppOwner(paths)?.gpuDeviceUuid).toBe(uuid);
      expect(fixture.createLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          bindings: expect.objectContaining({ gpuDeviceUuid: uuid }),
        }),
      );
    } finally {
      fs.rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  it("rejects install retry for a legacy Station runtime without changing its owner", async () => {
    const selected = stationSelection();
    const fixture = setup(selected);
    try {
      const paths = managedLlamaCppStatePaths(fixture.homeDir);
      reserveManagedLlamaCppOwner(paths, fixture.legacyOwner());
      seedLegacyRuntimeAuthority(selected, fixture.homeDir, fixture.operation.engine);
      const before = fs.readFileSync(paths.ownerPath);
      const result = await fixture.install();
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("destroy --yes") });
      expect(fixture.createLifecycle).not.toHaveBeenCalled();
      expect(fs.readFileSync(paths.ownerPath)).toEqual(before);
      expect(loadManagedLlamaCppOwner(paths)?.gpuDeviceUuid).toBeUndefined();
    } finally {
      fs.rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  it("rejects resume for a legacy Station runtime without changing its owner", async () => {
    const selected = stationSelection();
    const fixture = setup(selected);
    try {
      const paths = managedLlamaCppStatePaths(fixture.homeDir);
      reserveManagedLlamaCppOwner(paths, fixture.legacyOwner());
      seedLegacyRuntimeAuthority(selected, fixture.homeDir, fixture.operation.engine);
      loadOrCreateManagedLlamaCppApiKey(paths);
      fixture.operation.engine.capture(["network", "create", "nemoclaw-llama-cpp-internal"]);
      const before = fs.readFileSync(paths.ownerPath);
      await expect(
        resumeManagedLlamaCppRuntime("station-agent", {
          homeDir: fixture.homeDir,
          runtimeProvider: fixture.runtimeProvider,
          verifyGguf: fixture.verifyGguf,
        }),
      ).rejects.toThrow("destroy --yes");
      expect(fs.readFileSync(paths.ownerPath)).toEqual(before);
      expect(fixture.createLifecycle).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  it("retains an unfinished legacy Station journal while rejecting retry and resume", async () => {
    const selected = stationSelection();
    const fixture = setup(selected);
    try {
      const paths = managedLlamaCppStatePaths(fixture.homeDir);
      reserveManagedLlamaCppOwner(paths, fixture.legacyOwner());
      seedLegacyUnfinishedJournal(fixture.homeDir, fixture.operation.engine);
      const before = fs.readFileSync(paths.ownerPath);
      const result = await fixture.install();
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("destroy --yes") });
      await expect(
        resumeManagedLlamaCppRuntime("station-agent", {
          homeDir: fixture.homeDir,
          runtimeProvider: fixture.runtimeProvider,
          verifyGguf: fixture.verifyGguf,
        }),
      ).rejects.toThrow("destroy --yes");
      expect(fs.readFileSync(paths.ownerPath)).toEqual(before);
      expect(loadManagedLlamaCppOwner(paths)?.gpuDeviceUuid).toBeUndefined();
      expect(createHostLocalCreateJournalStore(paths.stateDir).list()).toMatchObject([
        { phase: "prepared" },
      ]);
      expect(fixture.createLifecycle).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  it("rehydrates a legacy Station owner for exact cleanup while rejecting startup", () => {
    const selected = stationSelection();
    const fixture = setup(selected);
    try {
      const paths = managedLlamaCppStatePaths(fixture.homeDir);
      reserveManagedLlamaCppOwner(paths, fixture.legacyOwner());
      seedLegacyRuntimeAuthority(selected, fixture.homeDir, fixture.operation.engine);
      const source = selected.recipe.spec.model;
      const file = source.files[0]!;
      const modelPath = path.join(
        fixture.homeDir,
        ".cache",
        "huggingface",
        "hub",
        `models--${source.id.replaceAll("/", "--")}`,
        "snapshots",
        source.revision,
        file.path,
      );
      fs.mkdirSync(path.dirname(modelPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(modelPath, "legacy-station", { mode: 0o600 });
      const rehydrated = rehydrateManagedLlamaCppLifecycle({
        runtimeProvider: fixture.runtimeProvider,
        runtimeOwnerSandboxName: "station-agent",
        homeDir: fixture.homeDir,
        operation: fixture.operation,
      });
      expect(rehydrated.owner.gpuDeviceUuid).toBeUndefined();
      const [call] = fixture.createLifecycle.mock.calls[0] as unknown as [
        { bindings: { gpuDeviceUuid?: string } },
      ];
      expect(call.bindings.gpuDeviceUuid).toBeUndefined();
      expect(() =>
        requireStationGb300StartupGpuAuthority(rehydrated.owner, rehydrated.selection),
      ).toThrow("destroy --yes");
    } finally {
      fs.rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });
});
