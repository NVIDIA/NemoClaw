// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { dockerLlamaCppBindingSha256 } from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceReceipt,
  HostLocalLlamaCppLifecycle,
} from "../../onboard/runtime-provider/host-local-inference";
import { isLlamaCppServingRecipe } from "../serving/adapter-registry";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ResolvedLlamaCppInferenceSelection } from "../serving/types";
import { installManagedLlamaCpp, selectStationGb300GpuUuid } from "./managed-installer";
import { engineHarness } from "./managed-installer.test-support";
import { loadManagedLlamaCppOwner, managedLlamaCppStatePaths } from "./managed-state";

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
    { uuid, name: "NVIDIA GB300", totalMemoryMB: 256703, availableMemoryMB: 250000 },
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

  it("persists the proved UUID in lifecycle authority", async () => {
    const selected = stationSelection();
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-")));
    try {
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
      const hostPath = path.join(homeDir, "model.gguf");
      fs.writeFileSync(hostPath, "fixture", { mode: 0o600 });
      const identity = fs.lstatSync(hostPath, { bigint: true });
      const result = await installManagedLlamaCpp(selected, {
        sandboxName: "station-agent",
        homeDir,
        runtimeProvider: {
          ...provider,
          hostLocalInference: {
            providerId: "docker",
            supported: true,
            services: ["llama-cpp"],
            createOperation: vi.fn(() => operation),
          },
        },
        gpu,
        verifyGguf: vi.fn(async () => ({
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
        })),
        checkPort: vi.fn(async () => ({ ok: true })),
        log: vi.fn(),
      });
      expect(result.ok).toBe(true);
      expect(loadManagedLlamaCppOwner(managedLlamaCppStatePaths(homeDir))?.gpuDeviceUuid).toBe(
        uuid,
      );
      expect(createLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ bindings: expect.objectContaining({ gpuDeviceUuid: uuid }) }),
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
