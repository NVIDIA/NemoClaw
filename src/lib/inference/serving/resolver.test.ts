// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SystemReadinessReport } from "../../readiness/types.js";
import { managedInferenceDigest } from "./catalog-integrity.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
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
  ManagedInferencePresetRequirement,
  ManagedInferenceReadinessSource,
  ManagedInferenceResolverInput,
  ManagedInferenceServingPreset,
  ManagedInferenceServingRecipe,
  ManagedInferenceTopologyQualification,
} from "./types.js";

const NOW = new Date("2026-08-02T18:00:00.000Z");
const SOURCE_REVISION = "a".repeat(40);

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
  return shippedCompiledRecipe(catalog);
}

function shippedFixtureCatalog(): CompiledManagedInferenceCatalog {
  const catalog = shippedCatalog();
  return {
    ...catalog,
    presets: [shippedCompiledPreset(catalog)],
    recipes: [shippedCompiledRecipe(catalog)],
  };
}

function catalogReadinessEntities(): Pick<
  SystemReadinessReport,
  "observations" | "capabilities" | "qualifications"
> {
  const readinessRequirements = shippedPreset().spec.requirements.all.flatMap((requirement) =>
    "readiness" in requirement ? [requirement.readiness] : [],
  );
  return {
    observations: readinessRequirements.flatMap((readiness) =>
      readiness.kind === "observation" && "state" in readiness
        ? [
            {
              id: readiness.id,
              state: readiness.state as SystemReadinessReport["observations"][number]["state"],
            },
          ]
        : [],
    ),
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

function readinessReport(overrides: Partial<SystemReadinessReport> = {}): SystemReadinessReport {
  const entities = catalogReadinessEntities();
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
    const selected = result as Extract<typeof result, { outcome: "selected" }>;
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";
    expect(selected.topologyQualification.output.masterAddress).toBe("192.168.100.10");
    expect(Object.isFrozen(selected.topologyQualification.output)).toBe(true);
  });

  it.each([
    { name: "provider", intent: { provider: "vllm" } },
    { name: "model", intent: { vllmModel: "another/model" } },
    { name: "extra arguments", intent: { vllmExtraArguments: ["--another-option"] } },
  ])("leaves existing $name intent authoritative for automatic selection", ({ intent }) => {
    expect(
      resolveManagedInferenceServing({
        readinessReports: [],
        topologyQualifications: [],
        intent,
        now: NOW,
      }),
    ).toMatchObject({ outcome: "no-match", code: "explicit-intent" });
  });

  it("rejects an unknown explicit preset", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ intent: { preset: "vllm.unknown" } })),
    ).toMatchObject({ outcome: "rejected", code: "unknown-preset" });
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
    ).toMatchObject({ outcome: "rejected", code: "invalid-readiness" });
  });

  it("rejects a non-finite resolution time", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ now: new Date(Number.NaN) })),
    ).toMatchObject({ outcome: "rejected", code: "invalid-readiness" });
  });

  it.each([1, 3])("does not activate automatically for %i readiness reports", (count) => {
    const reports = [
      ...readinessSources(),
      { nodeId: "spark-third", report: readinessReport() },
    ].slice(0, count);

    expect(
      resolveManagedInferenceServing(resolverInput({ readinessReports: reports })),
    ).toMatchObject({ outcome: "no-match", code: "requirements-not-met" });
  });

  it("does not activate automatically without the required topology artifact", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ topologyQualifications: [] })),
    ).toMatchObject({ outcome: "no-match", code: "requirements-not-met" });
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
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
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
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
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
