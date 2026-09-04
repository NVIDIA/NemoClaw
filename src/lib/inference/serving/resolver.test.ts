// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SystemReadinessReport } from "../../readiness/types.js";
import type { VllmProfile } from "../vllm.js";
import {
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
  isHostLocalInferenceServingRecipe,
  isManagedClusterInferenceServingRecipe,
} from "./adapter-registry.js";
import { managedInferenceDigest } from "./catalog-integrity.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
import { materializeHostLocalVllmSelection } from "./host-local-vllm-selection.js";
import {
  FIXTURE_MANAGED_CLUSTER_PRESET_ID,
  fixtureManagedClusterSelection,
} from "./managed-cluster-fixture.test-support.js";
import {
  type ManagedClusterTopologyOutput,
  managedClusterTopologyOutputDigest,
} from "./managed-cluster-topology.js";
import { resolveManagedInferenceServing } from "./resolver.js";
import type {
  CompiledManagedInferenceCatalog,
  HostLocalInferenceServingRecipe,
  ManagedInferencePresetRequirement,
  ManagedInferenceReadinessSource,
  ManagedInferenceResolverInput,
  ManagedInferenceServingPreset,
  ManagedInferenceServingRecipe,
  ManagedInferenceTopologyQualification,
  ResolvedHostLocalInferenceSelection,
} from "./types.js";

const NOW = new Date("2026-08-02T18:00:00.000Z");
const SOURCE_REVISION = "a".repeat(40);
const N1X_VLLM_PRESET_ID = "vllm.n1x.single.qwen3-6-35b-a3b-nvfp4";
const LINUX_VLLM_PROFILES = [
  {
    presetId: "vllm.linux-amd64-nvidia.single.muse-glimmer-30b-nvfp4-w4a4",
    recipeId: "vllm.muse-glimmer-30b-nvfp4-w4a4.linux-amd64-single.v1",
    model: "muse-glimmer-30b",
    minimumGpuMemoryBytes: 96_000_000_000,
  },
  {
    presetId: "vllm.linux-amd64-nvidia.single.nemotron-3.5-lightning-30b-a3b-nvfp4",
    recipeId: "vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1",
    model: "nemotron-3.5-lightning-30b",
    minimumGpuMemoryBytes: 96_000_000_000,
  },
] as const;
const STATION_LARGE_MODEL_PROFILES = [
  {
    presetId: "vllm.dgx-station-gb300.single.deepseek-v4-flash",
    model: "deepseek-v4-flash",
  },
  {
    presetId: "vllm.dgx-station-gb300.single.nemotron-3-ultra-550b-a55b-nvfp4",
    model: "nemotron-3-ultra-550b-a55b",
  },
] as const;

function shippedCatalog(): CompiledManagedInferenceCatalog {
  return structuredClone(loadManagedInferenceCatalog());
}

function shippedCompiledPreset(
  catalog = shippedCatalog(),
): CompiledManagedInferenceCatalog["presets"][number] {
  const preset = catalog.presets.find(
    ({ metadata }) => metadata.id === FIXTURE_MANAGED_CLUSTER_PRESET_ID,
  );
  expect(preset).toBeDefined();
  return preset as CompiledManagedInferenceCatalog["presets"][number];
}

function shippedPreset(catalog = shippedCatalog()): ManagedInferenceServingPreset {
  return shippedCompiledPreset(catalog);
}

function shippedCompiledRecipe(
  catalog = shippedCatalog(),
): CompiledManagedInferenceCatalog["recipes"][number] {
  const recipeRef = shippedCompiledPreset(catalog).spec.plan.recipeRef;
  const recipe = catalog.recipes.find(({ metadata }) => metadata.id === recipeRef);
  expect(recipe).toBeDefined();
  return recipe as CompiledManagedInferenceCatalog["recipes"][number];
}

function shippedRecipe(catalog = shippedCatalog()): ManagedInferenceServingRecipe {
  const recipe = shippedCompiledRecipe(catalog);
  expect(isManagedClusterInferenceServingRecipe(recipe)).toBe(true);
  return recipe as ManagedInferenceServingRecipe;
}

function shippedFixtureCatalog(): CompiledManagedInferenceCatalog {
  const catalog = shippedCatalog();
  return {
    ...catalog,
    presets: [shippedCompiledPreset(catalog)],
    recipes: [shippedCompiledRecipe(catalog)],
  };
}

function hostLocalFixtureCatalog(): CompiledManagedInferenceCatalog {
  const catalog = shippedCatalog();
  const sourceRecipe = catalog.recipes.find(
    (recipe): recipe is HostLocalInferenceServingRecipe =>
      isHostLocalInferenceServingRecipe(recipe) && recipe.spec.runtime.architecture === "arm64",
  );
  expect(sourceRecipe).toBeDefined();
  const sourcePreset = catalog.presets.find(
    ({ spec }) => spec.plan.recipeRef === sourceRecipe!.metadata.id,
  );
  expect(sourcePreset).toBeDefined();
  const recipe = {
    ...sourceRecipe!,
    metadata: { id: "test.vllm-host-local-recipe" },
    spec: {
      ...sourceRecipe!.spec,
      model: { ...sourceRecipe!.spec.model },
      execution: { ...sourceRecipe!.spec.execution },
      runtime: { ...sourceRecipe!.spec.runtime },
    },
  } satisfies HostLocalInferenceServingRecipe;
  const preset = {
    ...sourcePreset!,
    metadata: { id: "test.vllm-host-local-preset" },
    spec: {
      ...sourcePreset!.spec,
      selection: "explicit-only",
      requirements: {
        all: sourcePreset!.spec.requirements.all.filter(
          (requirement) => "readiness" in requirement,
        ),
      },
      plan: { backend: "vllm", recipeRef: recipe.metadata.id },
    },
  } as ManagedInferenceServingPreset;
  return { ...catalog, recipes: [recipe], presets: [preset] };
}

function catalogReadinessEntities(
  preset: ManagedInferenceServingPreset = shippedPreset(),
): Pick<SystemReadinessReport, "observations" | "capabilities" | "qualifications"> {
  const readinessRequirements = preset.spec.requirements.all.flatMap((requirement) =>
    "readiness" in requirement ? [requirement.readiness] : [],
  );
  return {
    observations: [
      ...readinessRequirements.flatMap((readiness) =>
        readiness.kind !== "observation"
          ? []
          : "state" in readiness
            ? [
                {
                  id: readiness.id,
                  state: readiness.state as SystemReadinessReport["observations"][number]["state"],
                },
              ]
            : [
                {
                  id: readiness.id,
                  state: "present" as const,
                  value:
                    readiness.comparison.operator === "one-of"
                      ? readiness.comparison.values[0]
                      : readiness.comparison.value,
                },
              ],
      ),
      { id: "host.gpu.unified_memory", state: "present", value: true },
      { id: "host.gpu.memory_total_bytes", state: "present", value: 500_000_000_000 },
      { id: "host.gpu.memory_per_device_bytes", state: "present", value: 500_000_000_000 },
    ],
    capabilities: readinessRequirements.flatMap((readiness) =>
      readiness.kind === "capability"
        ? [
            {
              id: readiness.id,
              state: readiness.state as SystemReadinessReport["capabilities"][number]["state"],
            },
          ]
        : [],
    ),
    qualifications: readinessRequirements.flatMap((readiness) =>
      readiness.kind === "qualification"
        ? [
            {
              id: readiness.id,
              status: readiness.status as SystemReadinessReport["qualifications"][number]["status"],
            },
          ]
        : [],
    ),
  };
}

function readinessReport(
  overrides: Partial<SystemReadinessReport> = {},
  preset: ManagedInferenceServingPreset = shippedPreset(),
): SystemReadinessReport {
  const entities = catalogReadinessEntities(preset);
  return {
    schemaVersion: "1.1.0",
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: SOURCE_REVISION,
      observedAt: "2026-08-02T17:59:50.000Z",
    },
    ...entities,
    findings: [],
    evidence: [],
    status: "supported",
    exitCode: 0,
    ...overrides,
  } as SystemReadinessReport;
}

function readinessSources(): ManagedInferenceReadinessSource[] {
  return [
    { nodeId: "spark-head", report: readinessReport() },
    { nodeId: "spark-worker", report: readinessReport() },
  ];
}

function storageRemediableReadinessReport(
  extraFindings: SystemReadinessReport["findings"] = [],
  preset: ManagedInferenceServingPreset = shippedPreset(),
): SystemReadinessReport {
  const report = readinessReport({}, preset);
  return {
    ...report,
    capabilities: [
      ...report.capabilities.map((capability) =>
        capability.id === "host.docker.storage_compatible"
          ? { ...capability, state: "absent" as const }
          : capability.id === "host.docker.storage_remediation_available"
            ? { ...capability, state: "present" as const }
            : capability,
      ),
      ...(report.capabilities.some(({ id }) => id === "host.docker.storage_remediation_available")
        ? []
        : [{ id: "host.docker.storage_remediation_available", state: "present" as const }]),
    ],
    findings: [
      {
        id: "host.docker.storage_incompatible",
        severity: "blocking",
        summary: "The Docker storage configuration requires lifecycle remediation.",
        capabilityIds: ["host.docker.storage_compatible"],
      },
      ...extraFindings,
    ],
    status: "incompatible",
    exitCode: 2,
  };
}

function deferredN1xReadinessReport(
  extraFindings: SystemReadinessReport["findings"] = [],
  n1xState: "present" | "absent" = "present",
): SystemReadinessReport {
  const catalog = shippedCatalog();
  const preset = catalog.presets.find(({ metadata }) => metadata.id === N1X_VLLM_PRESET_ID);
  expect(preset).toBeDefined();
  const report = readinessReport({}, preset!);
  return {
    ...report,
    capabilities: [
      ...report.capabilities.map((capability) =>
        capability.id === "host.platform.n1x"
          ? { ...capability, state: n1xState }
          : capability,
      ),
      { id: "host.platform.supported", state: "absent" as const },
    ],
    findings: [
      {
        id: "host.platform.n1x_validation_pending",
        severity: "blocking",
        summary: "N1x platform validation is pending a physical NemoClaw Express E2E run.",
        capabilityIds: ["host.platform.n1x", "host.platform.supported"],
      },
      ...extraFindings,
    ],
    status: "incompatible",
    exitCode: 2,
  };
}

function deferredN1xWithRemediableStorageReport(
  extraFindings: SystemReadinessReport["findings"] = [],
): SystemReadinessReport {
  const report = deferredN1xReadinessReport([
    {
      id: "host.docker.storage_incompatible",
      severity: "blocking",
      summary: "The Docker storage configuration requires lifecycle remediation.",
      capabilityIds: ["host.docker.storage_compatible"],
    },
    ...extraFindings,
  ]);
  return {
    ...report,
    capabilities: [
      ...report.capabilities.map((capability) =>
        capability.id === "host.docker.storage_compatible"
          ? { ...capability, state: "absent" as const }
          : capability.id === "host.docker.storage_remediation_available"
            ? { ...capability, state: "present" as const }
            : capability,
      ),
      ...(report.capabilities.some(
        ({ id }) => id === "host.docker.storage_remediation_available",
      )
        ? []
        : [{ id: "host.docker.storage_remediation_available", state: "present" as const }]),
    ],
  };
}

function topology(
  overrides: Partial<ManagedInferenceTopologyQualification<ManagedClusterTopologyOutput>> = {},
): ManagedInferenceTopologyQualification<ManagedClusterTopologyOutput> {
  const artifact = structuredClone(fixtureManagedClusterSelection().topologyQualification);
  return { ...artifact, ...overrides };
}

function resolverInput(
  overrides: Partial<ManagedInferenceResolverInput<ManagedClusterTopologyOutput>> = {},
): ManagedInferenceResolverInput<ManagedClusterTopologyOutput> {
  return {
    readinessReports: readinessSources(),
    topologyQualifications: [topology()],
    now: NOW,
    ...overrides,
  };
}

function catalogWithSecondProfile(options: {
  readonly firstPriority: number;
  readonly secondPriority: number;
  readonly secondSelection?: "automatic" | "explicit-only" | "disabled";
}): {
  readonly catalog: CompiledManagedInferenceCatalog;
  readonly secondPresetId: string;
  readonly secondRecipeId: string;
} {
  const catalog = shippedCatalog();
  const firstCompiledRecipe = shippedCompiledRecipe(catalog);
  const firstPreset = shippedPreset(catalog);
  const firstRecipe = shippedRecipe(catalog);
  const secondPresetId = "vllm.synthetic.dual-second";
  const secondRecipeId = "vllm.synthetic.second-recipe";
  const normalizedFirst = {
    ...firstPreset,
    spec: { ...firstPreset.spec, priority: options.firstPriority },
  } as ManagedInferenceServingPreset;
  const secondRecipe = {
    ...firstRecipe,
    metadata: {
      ...firstRecipe.metadata,
      id: secondRecipeId,
      displayName: "Synthetic model",
    },
    spec: {
      ...firstRecipe.spec,
      model: {
        ...firstRecipe.spec.model,
        id: "example/AnotherModel",
        revision: "b".repeat(40),
        servedName: "another-model",
      },
      readiness: {
        ...firstRecipe.spec.readiness,
        expectedModel: "another-model",
      },
    },
  } as ManagedInferenceServingRecipe;
  const secondPreset = {
    ...firstPreset,
    metadata: {
      ...firstPreset.metadata,
      id: secondPresetId,
      displayName: "Synthetic preset",
    },
    spec: {
      ...firstPreset.spec,
      selection: options.secondSelection ?? "automatic",
      priority: options.secondPriority,
      plan: { ...firstPreset.spec.plan, recipeRef: secondRecipeId },
    },
  } as ManagedInferenceServingPreset;
  return {
    catalog: {
      ...catalog,
      presets: [normalizedFirst, secondPreset],
      recipes: [firstCompiledRecipe, secondRecipe],
    },
    secondPresetId,
    secondRecipeId,
  };
}

describe("managed inference resolver", () => {
  it.each(STATION_LARGE_MODEL_PROFILES)(
    "selects the supported single-Station $model profile at physical GB300 HBM capacity (#9850)",
    ({ presetId, model }) => {
      const catalog = shippedCatalog();
      const preset = catalog.presets.find(({ metadata }) => metadata.id === presetId);
      expect(preset).toBeDefined();
      const base = readinessReport({}, preset!);
      const physicalGb300MemoryBytes = 269_172_604_928;
      const report = {
        ...base,
        observations: base.observations.map((observation) =>
          observation.id === "host.gpu.memory_total_bytes" ||
          observation.id === "host.gpu.memory_per_device_bytes"
            ? { ...observation, value: physicalGb300MemoryBytes }
            : observation,
        ),
      } as SystemReadinessReport;

      expect(
        resolveManagedInferenceServing(
          {
            readinessReports: [{ nodeId: "station", report }],
            topologyQualifications: [],
            intent: { provider: "vllm", vllmModel: model },
            now: NOW,
          },
          catalog,
        ),
      ).toMatchObject({
        outcome: "selected",
        selection: "explicit",
        preset: { metadata: { id: presetId } },
      });
    },
  );

  it.each(LINUX_VLLM_PROFILES)(
    "selects the shipped Linux amd64 profile for direct model $model (#9673)",
    ({ presetId, recipeId, model }) => {
      const catalog = shippedCatalog();
      const preset = catalog.presets.find(({ metadata }) => metadata.id === presetId);
      expect(preset).toBeDefined();

      const result = resolveManagedInferenceServing(
        {
          readinessReports: [{ nodeId: "linux-host", report: readinessReport({}, preset!) }],
          topologyQualifications: [],
          intent: { provider: "vllm", vllmModel: model },
          now: NOW,
        },
        catalog,
      );

      expect(result).toMatchObject({
        outcome: "selected",
        selection: "explicit",
        preset: { metadata: { id: presetId } },
        recipe: { metadata: { id: recipeId } },
      });
    },
  );

  it.each([
    "MUSE-GLIMMER-30B",
    "INFERACT/MUSE-GLIMMER-30B-NVFP4-W4A4",
  ])("matches documented model aliases case-insensitively: %s", (model) => {
    const catalog = shippedCatalog();
    const { presetId, recipeId } = LINUX_VLLM_PROFILES[0];
    const preset = catalog.presets.find(({ metadata }) => metadata.id === presetId);
    expect(preset).toBeDefined();

    expect(
      resolveManagedInferenceServing(
        {
          readinessReports: [{ nodeId: "linux-host", report: readinessReport({}, preset!) }],
          topologyQualifications: [],
          intent: { provider: "vllm", vllmModel: model },
          now: NOW,
        },
        catalog,
      ),
    ).toMatchObject({
      outcome: "selected",
      selection: "explicit",
      preset: { metadata: { id: presetId } },
      recipe: { metadata: { id: recipeId } },
    });
  });

  it.each(LINUX_VLLM_PROFILES)(
    "enforces the Linux amd64 $model GPU memory boundary (#9673)",
    ({ presetId, model, minimumGpuMemoryBytes }) => {
      const catalog = shippedCatalog();
      const preset = catalog.presets.find(({ metadata }) => metadata.id === presetId);
      expect(preset).toBeDefined();
      const base = readinessReport({}, preset!);
      const resolveAtMemory = (memoryBytes: number) => {
        const report = {
          ...base,
          observations: base.observations.map((observation) =>
            observation.id === "host.gpu.memory_total_bytes" ||
            observation.id === "host.gpu.memory_per_device_bytes"
              ? { ...observation, value: memoryBytes }
              : observation,
          ),
        } as SystemReadinessReport;
        return resolveManagedInferenceServing(
          {
            readinessReports: [{ nodeId: "linux-host", report }],
            topologyQualifications: [],
            intent: { provider: "vllm", vllmModel: model },
            now: NOW,
          },
          catalog,
        );
      };

      expect(resolveAtMemory(minimumGpuMemoryBytes - 1)).toMatchObject({
        outcome: "rejected",
        code: "requirements-not-met",
      });
      expect(resolveAtMemory(minimumGpuMemoryBytes)).toMatchObject({
        outcome: "selected",
        selection: "explicit",
        preset: { metadata: { id: presetId } },
      });
    },
  );

  it("rejects the Linux amd64 Muse profile on arm64 (#9673)", () => {
    const catalog = shippedCatalog();
    const { presetId, model } = LINUX_VLLM_PROFILES[0];
    const preset = catalog.presets.find(({ metadata }) => metadata.id === presetId);
    expect(preset).toBeDefined();
    const base = readinessReport({}, preset!);
    const report = {
      ...base,
      observations: base.observations.map((observation) =>
        observation.id === "host.os.architecture"
          ? { ...observation, value: "arm64" }
          : observation,
      ),
    } as SystemReadinessReport;

    expect(
      resolveManagedInferenceServing(
        {
          readinessReports: [{ nodeId: "linux-host", report }],
          topologyQualifications: [],
          intent: { provider: "vllm", vllmModel: model },
          now: NOW,
        },
        catalog,
      ),
    ).toMatchObject({ outcome: "rejected", code: "requirements-not-met" });
  });

  it("resolves an explicit host-local vLLM preset without topology data (#8246)", () => {
    const catalog = hostLocalFixtureCatalog();
    const presetId = catalog.presets[0]!.metadata.id;
    const input = resolverInput({
      intent: { preset: presetId },
      readinessReports: [{ nodeId: "spark", report: readinessReport({}, catalog.presets[0]!) }],
    });
    const result = resolveManagedInferenceServing(
      { ...input, topologyQualifications: [] },
      catalog,
    );

    expect(result).toMatchObject({
      outcome: "selected",
      selection: "explicit",
      preset: { metadata: { id: presetId } },
      recipe: { metadata: { id: catalog.recipes[0]!.metadata.id } },
    });
    expect(result).not.toHaveProperty("topologyQualification");
  });

  it("resolves a direct model slug only after its full host requirements match", () => {
    const catalog = hostLocalFixtureCatalog();
    const recipe = catalog.recipes[0] as HostLocalInferenceServingRecipe;
    const report = readinessReport({}, catalog.presets[0]!);
    const result = resolveManagedInferenceServing(
      {
        readinessReports: [{ nodeId: "host", report }],
        topologyQualifications: [],
        intent: { provider: "vllm", vllmModel: recipe.spec.model.environmentValue },
        now: NOW,
      },
      catalog,
    );

    expect(result).toMatchObject({
      outcome: "selected",
      selection: "explicit",
      preset: { metadata: { id: catalog.presets[0]!.metadata.id } },
    });
  });

  it("rejects a direct model before materialization when GPU memory is below its floor", () => {
    const catalog = hostLocalFixtureCatalog();
    const recipe = catalog.recipes[0] as HostLocalInferenceServingRecipe;
    const base = readinessReport({}, catalog.presets[0]!);
    const report = {
      ...base,
      observations: base.observations.map((observation) =>
        observation.id === "host.gpu.memory_total_bytes" ||
        observation.id === "host.gpu.memory_per_device_bytes"
          ? { ...observation, value: 1 }
          : observation,
      ),
    } as SystemReadinessReport;

    expect(
      resolveManagedInferenceServing(
        {
          readinessReports: [{ nodeId: "host", report }],
          topologyQualifications: [],
          intent: { vllmModel: recipe.spec.model.environmentValue },
          now: NOW,
        },
        catalog,
      ),
    ).toMatchObject({ outcome: "rejected", code: "requirements-not-met" });
  });

  it("materializes a host-local selection into the existing single-Spark runtime (#8246)", () => {
    const catalog = hostLocalFixtureCatalog();
    const presetId = catalog.presets[0]!.metadata.id;
    const input = resolverInput({
      intent: { preset: presetId },
      readinessReports: [{ nodeId: "spark", report: readinessReport({}, catalog.presets[0]!) }],
    });
    const result = resolveManagedInferenceServing(
      { ...input, topologyQualifications: [] },
      catalog,
    );
    expect(result.outcome).toBe("selected");
    expect(result).not.toHaveProperty("topologyQualification");
    expect(result).toHaveProperty("recipe");
    const selectedResult = result as ResolvedHostLocalInferenceSelection;
    expect(isHostLocalInferenceServingRecipe(selectedResult.recipe)).toBe(true);
    const baseProfile = {
      name: "DGX Spark",
      platform: "spark",
      architecture: "arm64",
      image: "example.invalid/vllm@sha256:" + "a".repeat(64),
      imageDownloadSizeBytes: 1,
      defaultModel: {} as never,
      containerName: "nemoclaw-vllm",
      dockerRunFlags: ["--gpus", "all"],
      pullTimeoutSec: 1,
      loadTimeoutSec: 1,
    } satisfies VllmProfile;
    const selected = materializeHostLocalVllmSelection(selectedResult, baseProfile);

    expect(selected).toMatchObject({
      presetId,
      recipeId: catalog.recipes[0]!.metadata.id,
      profile: {
        platform: "spark",
      },
      model: {
        id: catalog.recipes[0]!.spec.model.id,
        platforms: ["spark"],
      },
    });
    expect(selected.profile.servingCatalog).toBeUndefined();
    expect(selected.model.managedBearerAuth).toBeUndefined();
    expect(selected.model.fixedServeCommand).toBeUndefined();
  });

  it("selects the shipped automatic preset from catalog data", () => {
    const catalog = shippedFixtureCatalog();
    const compiledPreset = shippedCompiledPreset(catalog);
    const compiledRecipe = shippedCompiledRecipe(catalog);
    const result = resolveManagedInferenceServing(resolverInput(), catalog);

    expect(result).toMatchObject({
      outcome: "selected",
      selection: "automatic",
      presetDigest: managedInferenceDigest(compiledPreset),
      recipeDigest: managedInferenceDigest(compiledRecipe),
      preset: { metadata: { id: shippedPreset(catalog).metadata.id } },
      recipe: { metadata: { id: shippedRecipe(catalog).metadata.id } },
      topologyQualification: { output: { masterAddress: "192.168.100.10" } },
    });
  });

  it("looks up and resolves an arbitrary explicit-only preset by ID", () => {
    const { catalog, secondPresetId, secondRecipeId } = catalogWithSecondProfile({
      firstPriority: 100,
      secondPriority: 1,
      secondSelection: "explicit-only",
    });
    const result = resolveManagedInferenceServing(
      resolverInput({
        intent: { preset: secondPresetId, vllmModel: "another-model" },
      }),
      catalog,
    );

    expect(result).toMatchObject({
      outcome: "selected",
      selection: "explicit",
      preset: { metadata: { id: secondPresetId } },
      recipe: { metadata: { id: secondRecipeId } },
    });
  });

  it("selects the highest-priority matching automatic preset", () => {
    const { catalog, secondPresetId, secondRecipeId } = catalogWithSecondProfile({
      firstPriority: 100,
      secondPriority: 200,
    });
    const result = resolveManagedInferenceServing(resolverInput(), catalog);

    expect(result).toMatchObject({
      outcome: "selected",
      preset: { metadata: { id: secondPresetId } },
      recipe: { metadata: { id: secondRecipeId } },
    });
  });

  it("selects a lower-priority profile when higher-priority requirements do not match", () => {
    const {
      catalog: baseCatalog,
      secondPresetId,
      secondRecipeId,
    } = catalogWithSecondProfile({
      firstPriority: 200,
      secondPriority: 100,
    });
    const highCompiledPreset = shippedCompiledPreset(baseCatalog);
    const secondCompiledPreset = baseCatalog.presets.find(
      ({ metadata }) => metadata.id === secondPresetId,
    );
    expect(secondCompiledPreset).toBeDefined();
    const highPreset = highCompiledPreset;
    const unavailableHighPreset = {
      ...highPreset,
      spec: {
        ...highPreset.spec,
        requirements: {
          all: [
            {
              readiness: {
                scope: "everyNode",
                kind: "capability",
                id: "host.synthetic.unavailable",
                state: "present",
              },
            },
            ...highPreset.spec.requirements.all,
          ],
        },
      },
    } as ManagedInferenceServingPreset;
    const catalog: CompiledManagedInferenceCatalog = {
      ...baseCatalog,
      presets: [
        unavailableHighPreset,
        secondCompiledPreset as CompiledManagedInferenceCatalog["presets"][number],
      ],
    };

    expect(resolveManagedInferenceServing(resolverInput(), catalog)).toMatchObject({
      outcome: "selected",
      preset: { metadata: { id: secondPresetId } },
      recipe: { metadata: { id: secondRecipeId } },
    });
  });

  it("rejects equal-priority automatic matches as ambiguous", () => {
    const { catalog, secondPresetId } = catalogWithSecondProfile({
      firstPriority: 100,
      secondPriority: 100,
    });
    const result = resolveManagedInferenceServing(resolverInput(), catalog);

    expect(result).toMatchObject({
      outcome: "rejected",
      code: "ambiguous-selection",
    });
    const rejected = result as Extract<typeof result, { outcome: "rejected" }>;
    expect(rejected.message).toContain(shippedPreset(catalog).metadata.id);
    expect(rejected.message).toContain(secondPresetId);
  });

  it("evaluates registered readiness entities and numeric facts without profile branches", () => {
    const catalog = shippedCatalog();
    const preset = shippedPreset(catalog);
    const topologyRequirement = preset.spec.requirements.all.find(
      (requirement) => "topologyQualification" in requirement,
    );
    expect(topologyRequirement).toBeDefined();
    const genericRequirements: ManagedInferencePresetRequirement[] = [
      {
        readiness: {
          scope: "everyNode",
          kind: "capability",
          id: "host.docker.available",
          state: "present",
        },
      },
      {
        fact: "cluster.nodeCount",
        state: "present",
        operator: "between",
        value: [2, 2],
      },
      topologyRequirement as ManagedInferencePresetRequirement,
    ];
    const customizedPreset = {
      ...preset,
      spec: {
        ...preset.spec,
        requirements: { all: genericRequirements },
      },
    } as ManagedInferenceServingPreset;
    const customizedCatalog: CompiledManagedInferenceCatalog = {
      ...catalog,
      presets: [customizedPreset],
    };

    expect(resolveManagedInferenceServing(resolverInput(), customizedCatalog)).toMatchObject({
      outcome: "selected",
    });
    const missingCapability = readinessSources();
    missingCapability[1] = {
      nodeId: "spark-worker",
      report: readinessReport({
        capabilities: readinessReport().capabilities.map((capability) =>
          capability.id === "host.docker.available"
            ? { ...capability, state: "absent" }
            : capability,
        ),
      }),
    };
    expect(
      resolveManagedInferenceServing(
        resolverInput({ readinessReports: missingCapability }),
        customizedCatalog,
      ),
    ).toMatchObject({ outcome: "no-match", code: "requirements-not-met" });
  });

  it.each(
    Array.from(
      [
        ["equals", "host.os.platform", "windows"],
        ["one-of", "host.os.architecture", "riscv64"],
        ["at-least", "host.gpu.count", 0],
        ["version-at-least", "host.gpu.driver_version", "580.65"],
        ["malformed version-at-least", "host.gpu.driver_version", "580.65.x"],
        [
          "version segment above Number.MAX_SAFE_INTEGER",
          "host.gpu.driver_version",
          "9007199254740992.1",
        ],
      ] as const,
      (value) => [value],
    ),
  )(
    "selects a preset only when readiness observation comparisons match [case %#] (#8246)",
    ([caseName, id, value]) => {
      const catalog = hostLocalFixtureCatalog();
      const preset = catalog.presets[0]!;
      const comparedPreset = {
        ...preset,
        spec: {
          ...preset.spec,
          requirements: {
            all: [
              {
                readiness: {
                  scope: "everyNode",
                  kind: "observation",
                  id: "host.os.platform",
                  comparison: { operator: "equals", value: "linux" },
                },
              },
              {
                readiness: {
                  scope: "everyNode",
                  kind: "observation",
                  id: "host.os.architecture",
                  comparison: { operator: "one-of", values: ["arm64", "amd64"] },
                },
              },
              {
                readiness: {
                  scope: "everyNode",
                  kind: "observation",
                  id: "host.gpu.count",
                  comparison: { operator: "at-least", value: 1 },
                },
              },
              {
                readiness: {
                  scope: "everyNode",
                  kind: "observation",
                  id: "host.gpu.driver_version",
                  comparison: { operator: "version-at-least", value: "580.65.6" },
                },
              },
            ],
          },
        },
      } as ManagedInferenceServingPreset;
      const comparedCatalog: CompiledManagedInferenceCatalog = {
        ...catalog,
        presets: [comparedPreset],
      };
      const reports = readinessSources().map(({ nodeId, report }) => ({
        nodeId,
        report: readinessReport({
          ...report,
          observations: [
            { id: "host.os.platform", state: "present", value: "linux" },
            { id: "host.os.architecture", state: "present", value: "arm64" },
            { id: "host.gpu.count", state: "present", value: 1 },
            { id: "host.gpu.driver_version", state: "present", value: "580.65.06" },
            { id: "host.gpu.unified_memory", state: "present", value: true },
            {
              id: "host.gpu.memory_total_bytes",
              state: "present",
              value: 500_000_000_000,
            },
            {
              id: "host.gpu.memory_per_device_bytes",
              state: "present",
              value: 500_000_000_000,
            },
          ],
        }),
      }));

      expect(
        resolveManagedInferenceServing(
          resolverInput({
            readinessReports: reports,
            topologyQualifications: [],
            intent: { preset: preset.metadata.id },
          }),
          comparedCatalog,
        ),
      ).toMatchObject({ outcome: "selected" });

      const rejectedReports = reports.map(({ nodeId, report }, index) => ({
        nodeId,
        report: readinessReport({
          ...report,
          observations: report.observations.map((observation) =>
            index === 1 && observation.id === id ? { ...observation, value } : observation,
          ),
        }),
      }));
      expect(
        resolveManagedInferenceServing(
          resolverInput({
            readinessReports: rejectedReports,
            topologyQualifications: [],
            intent: { preset: preset.metadata.id },
          }),
          comparedCatalog,
        ),
        `${caseName} must reject a nonmatching observation`,
      ).toMatchObject({ outcome: "rejected", code: "requirements-not-met" });
    },
  );

  it("applies any-node readiness requirements as an existential match", () => {
    const catalog = shippedCatalog();
    const preset = shippedPreset(catalog);
    const topologyRequirement = preset.spec.requirements.all.find(
      (requirement) => "topologyQualification" in requirement,
    );
    expect(topologyRequirement).toBeDefined();
    const customizedPreset = {
      ...preset,
      spec: {
        ...preset.spec,
        requirements: {
          all: [
            {
              readiness: {
                scope: "anyNode",
                kind: "capability",
                id: "host.docker.available",
                state: "present",
              },
            },
            topologyRequirement as ManagedInferencePresetRequirement,
          ],
        },
      },
    } as ManagedInferenceServingPreset;
    const customizedCatalog: CompiledManagedInferenceCatalog = {
      ...catalog,
      presets: [customizedPreset],
    };
    const reports = readinessSources();
    reports[1] = {
      nodeId: "spark-worker",
      report: readinessReport({
        capabilities: readinessReport().capabilities.map((capability) =>
          capability.id === "host.docker.available"
            ? { ...capability, state: "absent" }
            : capability,
        ),
      }),
    };

    expect(
      resolveManagedInferenceServing(
        resolverInput({ readinessReports: reports }),
        customizedCatalog,
      ),
    ).toMatchObject({ outcome: "selected" });

    reports[0] = {
      nodeId: "spark-head",
      report: readinessReport({
        capabilities: readinessReport().capabilities.map((capability) =>
          capability.id === "host.docker.available"
            ? { ...capability, state: "absent" }
            : capability,
        ),
      }),
    };
    expect(
      resolveManagedInferenceServing(
        resolverInput({ readinessReports: reports }),
        customizedCatalog,
      ),
    ).toMatchObject({ outcome: "no-match", code: "requirements-not-met" });
  });

  it("returns an immutable topology snapshot", () => {
    const artifact = topology();
    const result = resolveManagedInferenceServing(
      resolverInput({ topologyQualifications: [artifact] }),
    );

    expect(result.outcome).toBe("selected");
    const selected = result as Extract<typeof result, { outcome: "selected" }> & {
      readonly topologyQualification: ManagedInferenceTopologyQualification<ManagedClusterTopologyOutput>;
    };
    expect("topologyQualification" in selected).toBe(true);
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";
    expect(selected.topologyQualification.output.masterAddress).toBe("192.168.100.10");
    expect(Object.isFrozen(selected.topologyQualification.output)).toBe(true);
  });

  it("leaves unmodeled extra arguments authoritative for automatic selection", () => {
    expect(
      resolveManagedInferenceServing({
        readinessReports: [],
        topologyQualifications: [],
        intent: { vllmExtraArguments: ["--another-option"] },
        now: NOW,
      }),
    ).toMatchObject({ outcome: "no-match", code: "explicit-intent" });
  });

  it("ignores blank extra arguments during declarative selection", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({ intent: { vllmExtraArguments: ["", "   "] } }),
      ),
    ).toMatchObject({ outcome: "selected" });
  });

  it.each([
    { intent: { provider: "vllm" }, outcome: "no-match", code: "requirements-not-met" },
    {
      intent: { vllmModel: "another/model" },
      outcome: "rejected",
      code: "requirements-not-met",
    },
  ] as const)("routes declarative provider and model intent through selection", (expected) => {
    expect(
      resolveManagedInferenceServing({
        readinessReports: [],
        topologyQualifications: [],
        intent: expected.intent,
        now: NOW,
      }),
    ).toMatchObject({ outcome: expected.outcome, code: expected.code });
  });

  it("rejects an unknown explicit preset", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ intent: { preset: "vllm.unknown" } })),
    ).toMatchObject({
      outcome: "rejected",
      code: "unknown-preset",
    });
  });

  it("rejects a disabled explicit preset", () => {
    const { catalog, secondPresetId } = catalogWithSecondProfile({
      firstPriority: 100,
      secondPriority: 200,
      secondSelection: "disabled",
    });
    expect(
      resolveManagedInferenceServing(
        resolverInput({ intent: { preset: secondPresetId } }),
        catalog,
      ),
    ).toMatchObject({ outcome: "rejected", code: "requirements-not-met" });
  });

  it("rejects explicit preset intent that conflicts with its recipe", () => {
    const presetId = shippedPreset().metadata.id;
    expect(
      resolveManagedInferenceServing(
        resolverInput({
          intent: {
            preset: presetId,
            vllmExtraArguments: ["--max-model-len", "1"],
          },
        }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "incompatible-intent" });
  });

  it.each([
    {
      name: "stale provenance",
      report: readinessReport({
        provenance: {
          nemoclawVersion: "0.1.0",
          sourceRevision: SOURCE_REVISION,
          observedAt: "2026-08-02T17:00:00.000Z",
        },
      }),
    },
    {
      name: "incompatible report",
      report: readinessReport({ status: "incompatible", exitCode: 2 }),
    },
    {
      name: "blocking finding",
      report: readinessReport({
        findings: [{ id: "host.blocked", severity: "blocking", summary: "Blocked." }],
      }),
    },
  ])("rejects $name before selecting a recipe", ({ report }) => {
    const sources = readinessSources();
    sources[1] = { nodeId: "spark-worker", report };

    expect(
      resolveManagedInferenceServing(resolverInput({ readinessReports: sources })),
    ).toMatchObject({
      outcome: "rejected",
      code: "invalid-readiness",
    });
  });

  it("admits a storage conflict that the public lifecycle can remediate (#8246)", () => {
    const catalog = hostLocalFixtureCatalog();
    const preset = catalog.presets[0]!;
    const result = resolveManagedInferenceServing(
      {
        readinessReports: [
          { nodeId: "spark-head", report: storageRemediableReadinessReport([], preset) },
        ],
        topologyQualifications: [],
        intent: { preset: preset.metadata.id },
        now: NOW,
      },
      catalog,
    );

    expect(result).toMatchObject({ outcome: "selected", selection: "explicit" });
  });

  it("selects the N1x managed-vLLM preset with explicit Deferred preview intent (#9902)", () => {
    expect(
      resolveManagedInferenceServing({
        readinessReports: [{ nodeId: "n1x-host", report: deferredN1xReadinessReport() }],
        topologyQualifications: [],
        intent: { provider: "vllm" },
        now: NOW,
      }),
    ).toMatchObject({
      outcome: "selected",
      preset: { metadata: { id: N1X_VLLM_PRESET_ID } },
      recipe: {
        metadata: { id: "vllm.qwen3-6-35b-a3b-nvfp4.n1x-single.v1" },
      },
    });
  });

  it("selects the N1x managed-vLLM preset when Docker storage is remediable (#9902)", () => {
    expect(
      resolveManagedInferenceServing({
        readinessReports: [
          { nodeId: "n1x-host", report: deferredN1xWithRemediableStorageReport() },
        ],
        topologyQualifications: [],
        intent: { provider: "vllm" },
        now: NOW,
      }),
    ).toMatchObject({
      outcome: "selected",
      preset: { metadata: { id: N1X_VLLM_PRESET_ID } },
    });
  });

  it.each([
    {
      condition: "managed-vLLM intent is absent",
      intent: undefined,
      report: deferredN1xReadinessReport(),
    },
    {
      condition: "N1x identity is absent",
      intent: { provider: "vllm" },
      report: deferredN1xReadinessReport([], "absent"),
    },
    {
      condition: "another blocking finding remains",
      intent: { provider: "vllm" },
      report: deferredN1xReadinessReport([
        {
          id: "host.gpu.container_toolkit_missing",
          severity: "blocking",
          summary: "NVIDIA Container Toolkit is missing.",
          capabilityIds: ["host.gpu.container_toolkit_available"],
        },
      ]),
    },
    {
      condition: "another blocking finding remains with remediable storage",
      intent: { provider: "vllm" },
      report: deferredN1xWithRemediableStorageReport([
        {
          id: "host.gpu.container_toolkit_missing",
          severity: "blocking",
          summary: "NVIDIA Container Toolkit is missing.",
          capabilityIds: ["host.gpu.container_toolkit_available"],
        },
      ]),
    },
  ])("rejects Deferred N1x readiness when $condition (#9902)", ({ intent, report }) => {
    expect(
      resolveManagedInferenceServing({
        readinessReports: [{ nodeId: "n1x-host", report }],
        topologyQualifications: [],
        intent,
        now: NOW,
      }),
    ).toMatchObject({ outcome: "rejected", code: "invalid-readiness" });
  });

  it("rejects remediation when another blocking finding remains (#8246)", () => {
    const report = storageRemediableReadinessReport([
      {
        id: "host.gpu.container_toolkit_missing",
        severity: "blocking",
        summary: "NVIDIA Container Toolkit is missing.",
        capabilityIds: ["host.gpu.container_toolkit_available"],
      },
    ]);

    expect(
      resolveManagedInferenceServing(
        resolverInput({ readinessReports: [{ nodeId: "spark-head", report }] }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-readiness" });
  });

  it("rejects remediation when another fatal finding remains (#8246)", () => {
    const report = storageRemediableReadinessReport([
      {
        id: "host.gpu.unavailable",
        severity: "fatal",
        summary: "No supported GPU is available.",
        capabilityIds: ["host.gpu.available"],
      },
    ]);

    expect(
      resolveManagedInferenceServing(
        resolverInput({ readinessReports: [{ nodeId: "spark-head", report }] }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-readiness" });
  });

  it("rejects a storage conflict without the remediation capability (#8246)", () => {
    const remediable = storageRemediableReadinessReport();
    const report = {
      ...remediable,
      capabilities: remediable.capabilities.map((capability) =>
        capability.id === "host.docker.storage_remediation_available"
          ? { ...capability, state: "absent" as const }
          : capability,
      ),
    };

    expect(
      resolveManagedInferenceServing(
        resolverInput({ readinessReports: [{ nodeId: "spark-head", report }] }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-readiness" });
  });

  it("rejects a non-finite resolution time", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ now: new Date(Number.NaN) })),
    ).toMatchObject({
      outcome: "rejected",
      code: "invalid-readiness",
    });
  });

  it.each([1, 3])("does not activate automatically for %i readiness reports", (count) => {
    const reports = [
      ...readinessSources(),
      { nodeId: "spark-third", report: readinessReport() },
    ].slice(0, count);

    expect(
      resolveManagedInferenceServing(resolverInput({ readinessReports: reports })),
    ).toMatchObject({
      outcome: "no-match",
      code: "requirements-not-met",
    });
  });

  it("does not activate automatically without the required topology artifact", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ topologyQualifications: [] })),
    ).toMatchObject({
      outcome: "no-match",
      code: "requirements-not-met",
    });
  });

  it("rejects a topology artifact for different physical subjects", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({
          topologyQualifications: [topology({ subjectNodeIds: ["spark-head", "spark-third"] })],
        }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
  });

  it("rejects topology output mutated without a new digest", () => {
    const artifact = topology();
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";

    expect(
      resolveManagedInferenceServing(resolverInput({ topologyQualifications: [artifact] })),
    ).toMatchObject({
      outcome: "rejected",
      code: "invalid-topology",
    });
  });

  it("rejects a stale topology subject digest", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({
          topologyQualifications: [topology({ subjectDigest: `sha256:${"f".repeat(64)}` })],
        }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
  });

  it("rejects an internally inconsistent topology with a recomputed output digest", () => {
    const artifact = topology();
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";
    (artifact as { outputDigest: string }).outputDigest = managedClusterTopologyOutputDigest(
      artifact.output,
    );

    expect(
      resolveManagedInferenceServing(resolverInput({ topologyQualifications: [artifact] })),
    ).toMatchObject({
      outcome: "rejected",
      code: "invalid-topology",
    });
  });

  it("rejects ambiguous topology artifacts", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({ topologyQualifications: [topology(), topology()] }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
  });

  it("rejects missing requirements for an explicit preset instead of falling back", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({
          readinessReports: readinessSources().slice(0, 1),
          intent: { preset: shippedPreset().metadata.id },
        }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "requirements-not-met" });
  });
});
