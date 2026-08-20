// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
  LLAMA_CPP_HOST_LOCAL_LIFECYCLE_REF,
  LLAMA_CPP_HOST_LOCAL_MATERIALIZER_REF,
  MANAGED_CLUSTER_VLLM_LIFECYCLE_REF,
  MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
} from "./adapter-registry";
import { servingCatalogDigest } from "./catalog";
import {
  assertManagedInferenceCatalog,
  loadManagedInferenceCatalog,
  loadServingCatalog,
  managedInferenceCatalogFromServingCatalog,
} from "./catalog-loader";
import type { CompiledServingCatalog, ServingPreset, ServingRecipe } from "./types";

const EMPTY_CATALOG: CompiledServingCatalog = {
  schemaVersion: "1.1.0",
  compilerVersion: "1.4.0",
  sourceRevision: "a".repeat(40),
  readinessSchemaRef: "https://github.com/NVIDIA/NemoClaw/schemas/system-readiness.schema.json",
  models: [],
  recipes: [],
  presets: [],
  sources: [],
  catalogDigest: `sha256:${"b".repeat(64)}`,
};
const MANAGED_MATERIALIZER_REFS: ReadonlySet<string> = new Set([
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
  LLAMA_CPP_HOST_LOCAL_MATERIALIZER_REF,
  MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
]);
const MANAGED_LIFECYCLE_REFS: ReadonlySet<string> = new Set([
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  LLAMA_CPP_HOST_LOCAL_LIFECYCLE_REF,
  MANAGED_CLUSTER_VLLM_LIFECYCLE_REF,
]);

const INCOMPLETE_MANAGED_RECIPE: ServingRecipe = {
  apiVersion: "nemoclaw.nvidia.com/managed-inference/v1",
  kind: "ServingRecipe",
  metadata: { id: "test.incomplete-managed-recipe" },
  spec: {
    backend: "vllm",
    model: { id: "test/model", revision: "c".repeat(40) },
    execution: {
      materializerRef: MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
      lifecycleRef: MANAGED_CLUSTER_VLLM_LIFECYCLE_REF,
    },
  },
};

const INCOMPLETE_MANAGED_PRESET: ServingPreset = {
  apiVersion: "nemoclaw.nvidia.com/managed-inference/v1",
  kind: "ServingPreset",
  metadata: { id: "test.incomplete-managed-preset" },
  spec: {
    selection: "explicit-only",
    priority: 1,
    plan: { backend: "vllm", recipeRef: INCOMPLETE_MANAGED_RECIPE.metadata.id },
  },
};

const HOST_LOCAL_RECIPE: ServingRecipe = {
  apiVersion: "nemoclaw.nvidia.com/managed-inference/v1",
  kind: "ServingRecipe",
  metadata: { id: "test.host-local-recipe" },
  spec: {
    backend: "install-llama-cpp",
    model: { id: "test/model", revision: "d".repeat(40) },
    execution: {
      materializerRef: "llama-cpp.host-local/v1",
      lifecycleRef: "llama-cpp.host-local.lifecycle/v1",
    },
  },
};

const HOST_LOCAL_PRESET: ServingPreset = {
  apiVersion: "nemoclaw.nvidia.com/managed-inference/v1",
  kind: "ServingPreset",
  metadata: { id: "test.host-local-preset" },
  spec: {
    selection: "explicit-only",
    priority: 1,
    plan: {
      backend: "install-llama-cpp",
      recipeRef: HOST_LOCAL_RECIPE.metadata.id,
    },
  },
};

function managedCatalogValidationError(catalog: CompiledServingCatalog): string | undefined {
  try {
    assertManagedInferenceCatalog(catalog);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function expectManagedRuntimeDefinitions(
  catalog: CompiledServingCatalog,
  servingCatalog: CompiledServingCatalog = loadServingCatalog(),
): void {
  const { catalogDigest, ...catalogContents } = catalog;
  const expectedRecipes = servingCatalog.recipes.filter(
    ({ spec }) =>
      MANAGED_MATERIALIZER_REFS.has(spec.execution.materializerRef) ||
      MANAGED_LIFECYCLE_REFS.has(spec.execution.lifecycleRef),
  );
  const expectedRecipeIds = new Set(expectedRecipes.map(({ metadata }) => metadata.id));
  const expectedModelIds = new Set(
    expectedRecipes.flatMap(({ spec }) => (spec.modelRef ? [spec.modelRef] : [])),
  );
  const expectedPresets = servingCatalog.presets.filter(({ spec }) =>
    expectedRecipeIds.has(spec.plan.recipeRef),
  );
  const expectedDefinitionIds = new Set([
    ...expectedModelIds,
    ...expectedRecipeIds,
    ...expectedPresets.map(({ metadata }) => metadata.id),
  ]);

  expect(catalogDigest).toBe(servingCatalogDigest(catalogContents));
  expect(catalog.recipes.map(({ metadata }) => metadata.id)).toEqual(
    expectedRecipes.map(({ metadata }) => metadata.id),
  );
  expect(catalog.models.map(({ metadata }) => metadata.id)).toEqual(
    servingCatalog.models
      .filter(({ metadata }) => expectedModelIds.has(metadata.id))
      .map(({ metadata }) => metadata.id),
  );
  expect(catalog.presets.map(({ metadata }) => metadata.id)).toEqual(
    expectedPresets.map(({ metadata }) => metadata.id),
  );
  expect(catalog.sources.map(({ id }) => id)).toEqual(
    servingCatalog.sources.filter(({ id }) => expectedDefinitionIds.has(id)).map(({ id }) => id),
  );
}

describe("managed inference catalog loader", () => {
  it("accepts an empty managed catalog", () => {
    assertManagedInferenceCatalog(EMPTY_CATALOG);

    expect(EMPTY_CATALOG.recipes).toHaveLength(0);
  });

  it.each([
    ["recipe", { ...EMPTY_CATALOG, recipes: [INCOMPLETE_MANAGED_RECIPE] }],
    ["preset", { ...EMPTY_CATALOG, presets: [INCOMPLETE_MANAGED_PRESET] }],
  ] as const)("rejects an incomplete managed %s", (_label, catalog) => {
    expect(managedCatalogValidationError(catalog)).toMatch(/Managed inference (preset|recipe)/u);
  });

  it("rejects an incomplete registered llama.cpp definition (#8433)", () => {
    const servingCatalog: CompiledServingCatalog = {
      ...EMPTY_CATALOG,
      recipes: [HOST_LOCAL_RECIPE],
      presets: [HOST_LOCAL_PRESET],
    };

    expect(() => managedInferenceCatalogFromServingCatalog(servingCatalog)).toThrow(
      "Managed inference",
    );
  });

  it("retains registered host-local vLLM definitions (#8246)", () => {
    const servingCatalog = loadServingCatalog();
    const sourceRecipe = servingCatalog.recipes.find(
      ({ spec }) =>
        spec.execution.materializerRef === HOST_LOCAL_VLLM_MATERIALIZER_REF &&
        spec.execution.lifecycleRef === HOST_LOCAL_VLLM_LIFECYCLE_REF,
    )!;
    expect(sourceRecipe).toBeDefined();
    const sourceSpec = sourceRecipe.spec as Exclude<
      ServingRecipe["spec"],
      { backend: "install-llama-cpp" }
    >;
    const sourcePreset = servingCatalog.presets.find(
      ({ spec }) => spec.plan.recipeRef === sourceRecipe.metadata.id,
    )!;
    const recipe = {
      ...sourceRecipe,
      metadata: { id: "test.vllm-host-local-recipe" },
      spec: {
        ...sourceSpec,
        model: { ...sourceSpec.model },
        execution: { ...sourceSpec.execution },
        runtime: { ...sourceSpec.runtime },
      },
    } satisfies ServingRecipe;
    const preset = {
      ...sourcePreset,
      metadata: { id: "test.vllm-host-local-preset" },
      spec: {
        ...sourcePreset.spec,
        selection: "explicit-only",
        requirements: {
          all: sourcePreset.spec.requirements!.all.filter(
            (requirement) => "readiness" in requirement,
          ),
        },
        plan: { backend: "vllm", recipeRef: recipe.metadata.id },
      },
    } as ServingPreset;
    const projected = managedInferenceCatalogFromServingCatalog({
      ...EMPTY_CATALOG,
      recipes: [recipe],
      presets: [preset],
    });

    expect(projected.recipes.map(({ metadata }) => metadata.id)).toEqual([recipe.metadata.id]);
    expect(projected.presets.map(({ metadata }) => metadata.id)).toEqual([preset.metadata.id]);
  });

  it("retains the registered declarative llama.cpp definition (#8433)", () => {
    const servingCatalog = loadServingCatalog();
    const recipe = servingCatalog.recipes.find(
      ({ spec }) =>
        spec.execution.materializerRef === LLAMA_CPP_HOST_LOCAL_MATERIALIZER_REF &&
        spec.execution.lifecycleRef === LLAMA_CPP_HOST_LOCAL_LIFECYCLE_REF,
    );
    expect(recipe).toBeDefined();
    const projected = managedInferenceCatalogFromServingCatalog(servingCatalog);
    expect(projected.recipes.some(({ metadata }) => metadata.id === recipe!.metadata.id)).toBe(
      true,
    );
  });

  it("retains managed vLLM definitions while projecting the mixed serving catalog (#8173)", () => {
    const servingCatalog = loadServingCatalog();

    expect(servingCatalog.recipes.some(({ spec }) => spec.backend === "vllm")).toBe(true);
    expect(servingCatalog.recipes.some(({ spec }) => spec.backend === "install-llama-cpp")).toBe(
      true,
    );

    expectManagedRuntimeDefinitions(managedInferenceCatalogFromServingCatalog(servingCatalog));
  });

  it("loads every registered managed runtime through the public loader (#8433)", () => {
    const projectedCatalog = managedInferenceCatalogFromServingCatalog(loadServingCatalog());
    const loadedCatalog = loadManagedInferenceCatalog();

    expect(loadedCatalog).toEqual(projectedCatalog);
    expectManagedRuntimeDefinitions(loadedCatalog);
  });
});
