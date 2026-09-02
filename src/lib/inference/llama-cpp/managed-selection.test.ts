// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  type CollectHostObservationsOptions,
  createHostReadinessReport,
} from "../../readiness/host";
import type { SystemReadinessReport } from "../../readiness/types";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ManagedInferenceServingPreset } from "../serving/types";
import { LLAMA_CPP_RECIPE_ENV } from "./contract";
import {
  listManagedLlamaCppSelectionChoices,
  resolveManagedLlamaCppSelection,
  resolveManagedLlamaCppSelectionForGpu,
} from "./managed-selection";

const RECIPE_ID = "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1";
const GENERIC_PRESET_ID = "llama-cpp.linux-amd64-nvidia.single.nemotron-3-nano-30b-a3b";
const SPARK_PRESET_ID = "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b";
const MUSE_RECIPE_ID = "llama-cpp.muse-glimmer-30b.spark-single.v1";
const MUSE_PRESET_ID = "llama-cpp.dgx-spark-gb10.single.muse-glimmer-30b";
const N1X_WSL_RECIPE_ID = "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1";
const N1X_WSL_PRESET_ID = "llama-cpp.n1x-wsl-arm64.single.qwen3-6-35b-a3b";
const LOCAL_DOCKER_SELECTION = { dockerContextIsDefault: () => true } as const;

function readinessReport(
  preset: ManagedInferenceServingPreset,
  overrides: Partial<SystemReadinessReport> = {},
): SystemReadinessReport {
  const requirements = preset.spec.requirements.all.flatMap((requirement) =>
    "readiness" in requirement ? [requirement.readiness] : [],
  );
  return {
    schemaVersion: "1.1.0",
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      observedAt: new Date().toISOString(),
    },
    observations: requirements.flatMap((requirement) =>
      requirement.kind !== "observation"
        ? []
        : "state" in requirement
          ? [{ id: requirement.id, state: requirement.state }]
          : [
              {
                id: requirement.id,
                state: "present" as const,
                value:
                  requirement.comparison.operator === "one-of"
                    ? requirement.comparison.values[0]
                    : requirement.comparison.value,
              },
            ],
    ),
    capabilities: requirements.flatMap((requirement) =>
      requirement.kind === "capability" ? [{ id: requirement.id, state: requirement.state }] : [],
    ),
    qualifications: requirements.flatMap((requirement) =>
      requirement.kind === "qualification"
        ? [{ id: requirement.id, status: requirement.status }]
        : [],
    ),
    findings: [],
    evidence: [],
    status: "supported",
    exitCode: 0,
    ...overrides,
  } as SystemReadinessReport;
}

function fixture(presetId = SPARK_PRESET_ID) {
  const catalog = loadManagedInferenceCatalog();
  const preset = catalog.presets.find(({ metadata }) => metadata.id === presetId);
  expect(preset, "Shipped managed llama.cpp preset is missing.").toBeDefined();
  return { catalog, preset: preset!, report: readinessReport(preset!) };
}

function n1xCollectionOptions(): Omit<
  CollectHostObservationsOptions,
  "detectGpu" | "wslDockerDesktopGpuProofPassed"
> {
  const now = new Date();
  return {
    now: () => now,
    architecture: "arm64",
    assess: () => ({
      platform: "linux" as const,
      isWsl: true,
      runtime: "docker-desktop" as const,
      dockerInstalled: true,
      dockerRunning: true,
      dockerReachable: true,
      nodeInstalled: true,
      openshellInstalled: true,
      dockerCgroupVersion: "v2",
      dockerDefaultCgroupnsMode: "private",
      dockerStorageDriver: "overlay2",
      dockerUsesContainerdSnapshotter: false,
      dockerCpus: 12,
      dockerMemTotalBytes: 64 * 1024 ** 3,
      isContainerRuntimeUnderProvisioned: false,
      hasNestedOverlayConflict: false,
      requiresHostCgroupnsFix: false,
      isUnsupportedRuntime: false,
      isHeadlessLikely: false,
      hasNvidiaGpu: true,
      dockerCdiSpecDirs: ["/etc/cdi"],
      cdiNvidiaGpuSpecMissing: false,
      cdiNvidiaGpuSpecStale: false,
      cdiNvidiaGpuSpecNeedsRepair: false,
      nvidiaContainerToolkitInstalled: true,
      notes: [],
    }),
    collectPlatformIdentity: () => ({
      productName: "RTX Spark N1X",
      n1xWslProduct: true,
    }),
    detectNvidiaDriverVersion: () => "580.65.06",
  };
}

function withSyntheticRecipe(
  catalog: ReturnType<typeof loadManagedInferenceCatalog>,
  priority: number,
) {
  const recipe = catalog.recipes.find(({ metadata }) => metadata.id === RECIPE_ID)!;
  const preset = catalog.presets.find(({ metadata }) => metadata.id === SPARK_PRESET_ID)!;
  const recipeId = "llama-cpp.synthetic.spark-single.v1";
  const presetId = "llama-cpp.dgx-spark-gb10.single.synthetic";
  return {
    recipeId,
    presetId,
    catalog: {
      ...catalog,
      recipes: [...catalog.recipes, { ...recipe, metadata: { ...recipe.metadata, id: recipeId } }],
      presets: [
        ...catalog.presets,
        {
          ...preset,
          metadata: { ...preset.metadata, id: presetId, displayName: "Synthetic" },
          spec: {
            ...preset.spec,
            priority,
            plan: { ...preset.spec.plan, recipeRef: recipeId },
          },
        },
      ],
    },
  };
}

describe("managed llama.cpp selection", () => {
  it("selects from the production host-readiness projection for a qualified DGX Spark", () => {
    const { catalog } = fixture();
    const now = new Date();
    const report = createHostReadinessReport(
      {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        now: () => now,
      },
      {
        now: () => now,
        architecture: "arm64",
        assess: () => ({
          platform: "linux",
          isWsl: false,
          runtime: "docker",
          dockerInstalled: true,
          dockerRunning: true,
          dockerReachable: true,
          nodeInstalled: true,
          openshellInstalled: true,
          dockerCgroupVersion: "v2",
          dockerDefaultCgroupnsMode: "private",
          dockerStorageDriver: "overlay2",
          dockerUsesContainerdSnapshotter: false,
          dockerCpus: 20,
          dockerMemTotalBytes: 128 * 1024 ** 3,
          isContainerRuntimeUnderProvisioned: false,
          hasNestedOverlayConflict: false,
          requiresHostCgroupnsFix: false,
          isUnsupportedRuntime: false,
          isHeadlessLikely: false,
          hasNvidiaGpu: true,
          dockerCdiSpecDirs: ["/etc/cdi"],
          cdiNvidiaGpuSpecMissing: false,
          cdiNvidiaGpuSpecStale: false,
          cdiNvidiaGpuSpecNeedsRepair: false,
          nvidiaContainerToolkitInstalled: true,
          notes: [],
        }),
        collectPlatformIdentity: () => ({
          nvidiaPlatform: "spark",
          productName: "NVIDIA DGX Spark",
        }),
        detectGpu: () => ({ count: 1 }),
        detectHostGpuPlatform: () => "spark",
        detectNvidiaDriverVersion: () => "580.65.06",
      },
    );

    expect(resolveManagedLlamaCppSelection({}, catalog, report).kind).toBe("selected");
  });

  it("selects Nemotron by default on a qualified DGX Spark (#10239)", () => {
    const { catalog, report } = fixture();

    const resolved = resolveManagedLlamaCppSelection({}, catalog, report);

    expect(resolved).toMatchObject({
      kind: "selected",
      selection: {
        selection: "automatic",
        recipe: { metadata: { id: RECIPE_ID } },
        preset: {
          metadata: { id: SPARK_PRESET_ID },
          spec: { plan: { backend: "install-llama-cpp" } },
        },
      },
    });
  });

  it("selects managed Qwen 3.6 on a qualifying N1x WSL host (#10102)", () => {
    const { catalog, report } = fixture(N1X_WSL_PRESET_ID);

    expect(
      resolveManagedLlamaCppSelection(
        { [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID },
        catalog,
        report,
        LOCAL_DOCKER_SELECTION,
      ),
    ).toMatchObject({
      kind: "selected",
      selection: {
        recipe: { metadata: { id: N1X_WSL_RECIPE_ID } },
        preset: { metadata: { id: N1X_WSL_PRESET_ID } },
      },
    });
  });

  it("selects N1x WSL through the real preflight-proof readiness wrapper (#10102)", () => {
    const { catalog } = fixture(N1X_WSL_PRESET_ID);
    const gpu = {
      type: "nvidia",
      count: 1,
      totalMemoryMB: 49_088,
      perGpuMB: 49_088,
      nimCapable: true,
      wslDockerDesktopGpuProofPassed: true,
    };

    expect(
      resolveManagedLlamaCppSelectionForGpu(
        { [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID },
        gpu,
        catalog,
        n1xCollectionOptions(),
        LOCAL_DOCKER_SELECTION,
      ),
    ).toMatchObject({ kind: "selected" });
  });

  it("rejects an explicit remote Docker context for N1x WSL", () => {
    const { catalog, report } = fixture(N1X_WSL_PRESET_ID);
    const dockerContextIsDefault = vi.fn(() => false);

    expect(
      resolveManagedLlamaCppSelection(
        {
          [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID,
          DOCKER_CONTEXT: "remote-builder",
        },
        catalog,
        report,
        { dockerContextIsDefault },
      ),
    ).toMatchObject({
      kind: "rejected",
      reason: expect.stringContaining("effective Docker context to be default"),
    });
    expect(dockerContextIsDefault).toHaveBeenCalledWith(
      expect.objectContaining({ DOCKER_CONTEXT: "remote-builder" }),
    );
  });

  it("rejects a persisted remote Docker context for N1x WSL", () => {
    const { catalog, report } = fixture(N1X_WSL_PRESET_ID);
    const dockerContextIsDefault = vi.fn(() => false);

    expect(
      resolveManagedLlamaCppSelection(
        { [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID, HOME: "/home/test" },
        catalog,
        report,
        { dockerContextIsDefault },
      ),
    ).toMatchObject({
      kind: "rejected",
      reason: expect.stringContaining("effective Docker context to be default"),
    });
    expect(dockerContextIsDefault).toHaveBeenCalledOnce();
  });

  it("rejects N1x WSL when the real readiness wrapper receives failed GPU proof (#10102)", () => {
    const { catalog } = fixture(N1X_WSL_PRESET_ID);
    const gpu = {
      type: "nvidia",
      count: 1,
      totalMemoryMB: 49_088,
      perGpuMB: 49_088,
      nimCapable: true,
      wslDockerDesktopGpuProofPassed: false,
    };

    expect(
      resolveManagedLlamaCppSelectionForGpu(
        { [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID },
        gpu,
        catalog,
        n1xCollectionOptions(),
        LOCAL_DOCKER_SELECTION,
      ),
    ).toMatchObject({ kind: "rejected" });
  });

  it("rejects the N1x WSL recipe without Docker Desktop GPU proof (#10102)", () => {
    const { catalog, report } = fixture(N1X_WSL_PRESET_ID);
    const withoutGpuProof = {
      ...report,
      capabilities: report.capabilities.map((capability) =>
        capability.id === "host.platform.wsl_gpu_passthrough"
          ? { ...capability, state: "absent" as const }
          : capability,
      ),
    };

    expect(
      resolveManagedLlamaCppSelection(
        { [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID },
        catalog,
        withoutGpuProof,
        LOCAL_DOCKER_SELECTION,
      ),
    ).toMatchObject({ kind: "rejected" });
  });

  it("rejects the N1x WSL recipe without canonical N1x identity (#10102)", () => {
    const { catalog, report } = fixture(N1X_WSL_PRESET_ID);
    const withoutN1xIdentity = {
      ...report,
      qualifications: report.qualifications.map((qualification) =>
        qualification.id === "host.platform.n1x_wsl"
          ? { ...qualification, status: "unqualified" as const }
          : qualification,
      ),
    };

    expect(
      resolveManagedLlamaCppSelection(
        { [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID },
        catalog,
        withoutN1xIdentity,
        LOCAL_DOCKER_SELECTION,
      ),
    ).toMatchObject({ kind: "rejected" });
  });

  it("rejects the N1x WSL recipe below its independent GPU-memory floor (#10102)", () => {
    const { catalog, report } = fixture(N1X_WSL_PRESET_ID);
    const belowMemoryFloor = {
      ...report,
      observations: report.observations.map((observation) =>
        observation.id === "host.gpu.memory_total_bytes"
          ? { ...observation, value: 50_331_647_999 }
          : observation,
      ),
    };

    expect(
      resolveManagedLlamaCppSelection(
        { [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID },
        catalog,
        belowMemoryFloor,
        LOCAL_DOCKER_SELECTION,
      ),
    ).toMatchObject({ kind: "rejected" });
  });

  it("rejects the N1x WSL recipe without Docker Desktop runtime (#10102)", () => {
    const { catalog, report } = fixture(N1X_WSL_PRESET_ID);
    const nativeDocker = {
      ...report,
      observations: report.observations.map((observation) =>
        observation.id === "host.docker.runtime"
          ? { ...observation, value: "docker" }
          : observation,
      ),
    };

    expect(
      resolveManagedLlamaCppSelection(
        { [LLAMA_CPP_RECIPE_ENV]: N1X_WSL_RECIPE_ID },
        catalog,
        nativeDocker,
        LOCAL_DOCKER_SELECTION,
      ),
    ).toMatchObject({ kind: "rejected" });
  });

  it("selects the highest-priority compatible managed llama.cpp recipe", () => {
    const { catalog, report } = fixture();
    const synthetic = withSyntheticRecipe(catalog, 550);

    const resolved = resolveManagedLlamaCppSelection({}, synthetic.catalog, report);

    expect(resolved).toMatchObject({
      kind: "selected",
      selection: {
        selection: "automatic",
        recipe: { metadata: { id: synthetic.recipeId } },
        preset: { metadata: { id: synthetic.presetId } },
      },
    });
    expect(
      listManagedLlamaCppSelectionChoices(synthetic.catalog, report).map(
        ({ priority, selection }) => [priority, selection.recipe.metadata.id],
      ),
    ).toEqual([
      [550, synthetic.recipeId],
      [450, RECIPE_ID],
    ]);
  });

  it("rejects equal-priority automatic recipes instead of choosing by catalog order", () => {
    const { catalog, report } = fixture();
    const synthetic = withSyntheticRecipe(catalog, 450);

    expect(resolveManagedLlamaCppSelection({}, synthetic.catalog, report)).toEqual({
      kind: "rejected",
      reason: `Automatic managed llama.cpp selection is ambiguous at priority 450: ${SPARK_PRESET_ID}, ${synthetic.presetId}.`,
    });
  });

  it("selects explicit Muse instead of a higher-priority automatic recipe (#10239)", () => {
    const { catalog, report } = fixture();
    const synthetic = withSyntheticRecipe(catalog, 550);

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: MUSE_RECIPE_ID },
      synthetic.catalog,
      report,
    );

    expect(resolved).toMatchObject({
      kind: "selected",
      selection: {
        selection: "explicit",
        recipe: { metadata: { id: MUSE_RECIPE_ID } },
        preset: { metadata: { id: MUSE_PRESET_ID } },
      },
    });
  });

  it("selects the generic Linux amd64 NVIDIA GPU preset from the same declarative recipe", () => {
    const { catalog } = fixture(GENERIC_PRESET_ID);
    const now = new Date();
    const report = createHostReadinessReport(
      {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        now: () => now,
      },
      {
        now: () => now,
        architecture: "x64",
        assess: () => ({
          platform: "linux",
          isWsl: false,
          runtime: "docker",
          dockerInstalled: true,
          dockerRunning: true,
          dockerReachable: true,
          nodeInstalled: true,
          openshellInstalled: true,
          dockerCgroupVersion: "v2",
          dockerDefaultCgroupnsMode: "private",
          dockerStorageDriver: "overlay2",
          dockerUsesContainerdSnapshotter: false,
          dockerCpus: 16,
          dockerMemTotalBytes: 64 * 1024 ** 3,
          isContainerRuntimeUnderProvisioned: false,
          hasNestedOverlayConflict: false,
          requiresHostCgroupnsFix: false,
          isUnsupportedRuntime: false,
          isHeadlessLikely: true,
          hasNvidiaGpu: true,
          dockerCdiSpecDirs: ["/etc/cdi"],
          cdiNvidiaGpuSpecMissing: false,
          cdiNvidiaGpuSpecStale: false,
          cdiNvidiaGpuSpecNeedsRepair: false,
          nvidiaContainerToolkitInstalled: true,
          notes: [],
        }),
        collectPlatformIdentity: () => ({
          nvidiaPlatform: "linux",
          productName: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
        }),
        detectGpu: () => ({ count: 1 }),
        detectHostGpuPlatform: () => "linux",
        detectNvidiaDriverVersion: () => "595.84",
      },
    );

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: RECIPE_ID },
      catalog,
      report,
    );

    expect(resolved).toMatchObject({
      kind: "selected",
      selection: {
        recipe: { metadata: { id: RECIPE_ID } },
        preset: { metadata: { id: GENERIC_PRESET_ID } },
      },
    });
  });

  it("rejects a host that matches more than one hardware preset for one recipe", () => {
    const { catalog, preset, report } = fixture(GENERIC_PRESET_ID);
    const duplicate = {
      ...preset,
      metadata: { ...preset.metadata, id: `${GENERIC_PRESET_ID}.duplicate` },
    };

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: RECIPE_ID },
      { ...catalog, presets: [...catalog.presets, duplicate] },
      report,
    );

    expect(resolved).toEqual({
      kind: "rejected",
      reason: `Managed llama.cpp recipe ${RECIPE_ID} matches more than one serving preset: ${GENERIC_PRESET_ID}, ${GENERIC_PRESET_ID}.duplicate.`,
    });
  });

  it("selects an explicitly named shipped recipe", () => {
    const { catalog, report } = fixture();

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: RECIPE_ID },
      catalog,
      report,
    );

    expect(resolved.kind).toBe("selected");
  });

  it("rejects a model override outside the declarative recipe", () => {
    const { catalog, report } = fixture();

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: RECIPE_ID, NEMOCLAW_MODEL: "another/model" },
      catalog,
      report,
    );

    expect(resolved).toEqual({
      kind: "rejected",
      reason: `NEMOCLAW_MODEL cannot override the served model in ${LLAMA_CPP_RECIPE_ENV}.`,
    });
  });

  it("rejects stale host readiness before activation", () => {
    const { catalog, preset } = fixture();
    const stale = readinessReport(preset, {
      provenance: {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        observedAt: "2026-08-01T00:00:00.000Z",
      },
    });

    const resolved = resolveManagedLlamaCppSelection({}, catalog, stale);

    expect(resolved).toMatchObject({
      kind: "rejected",
      reason: expect.stringContaining("stale or has an invalid observation time"),
    });
  });
});
