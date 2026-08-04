// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
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
  schemaVersion: "1.0.0",
  compilerVersion: "1.1.0",
  sourceRevision: "a".repeat(40),
  readinessSchemaRef: "https://github.com/NVIDIA/NemoClaw/schemas/system-readiness.schema.json",
  recipes: [],
  presets: [],
  sources: [],
  catalogDigest: `sha256:${"b".repeat(64)}`,
};
const EXPECTED_MANAGED_RECIPE_IDS = ["vllm.deepseek-v4-flash-0731.spark-dual.v1"];
const EXPECTED_MANAGED_PRESET_IDS = ["vllm.dgx-spark-gb10.dual.deepseek-v4-flash-0731"];
const EXPECTED_MANAGED_SOURCE_IDS = [
  "vllm.dgx-spark-gb10.dual.deepseek-v4-flash-0731",
  "vllm.deepseek-v4-flash-0731.spark-dual.v1",
];

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
    plan: { backend: "install-llama-cpp", recipeRef: HOST_LOCAL_RECIPE.metadata.id },
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

function expectOnlyManagedVllmDefinitions(catalog: CompiledServingCatalog): void {
  const { catalogDigest, ...catalogContents } = catalog;

  expect(catalogDigest).toBe(servingCatalogDigest(catalogContents));
  expect(catalog.recipes.map(({ metadata }) => metadata.id)).toEqual(EXPECTED_MANAGED_RECIPE_IDS);
  expect(catalog.presets.map(({ metadata }) => metadata.id)).toEqual(EXPECTED_MANAGED_PRESET_IDS);
  expect(catalog.sources.map(({ id }) => id)).toEqual(EXPECTED_MANAGED_SOURCE_IDS);
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

  it("excludes host-local definitions from the managed-cluster runtime catalog (#8173)", () => {
    const servingCatalog: CompiledServingCatalog = {
      ...EMPTY_CATALOG,
      recipes: [HOST_LOCAL_RECIPE],
      presets: [HOST_LOCAL_PRESET],
    };

    const managedCatalog = managedInferenceCatalogFromServingCatalog(servingCatalog);

    expect(managedCatalog.recipes).toEqual([]);
    expect(managedCatalog.presets).toEqual([]);
    expect(managedCatalog.catalogDigest).not.toBe(EMPTY_CATALOG.catalogDigest);
    const { catalogDigest, ...catalogContents } = managedCatalog;
    expect(catalogDigest).toBe(servingCatalogDigest(catalogContents));
  });

  it("retains managed vLLM definitions while projecting the mixed serving catalog (#8173)", () => {
    const servingCatalog = loadServingCatalog();

    expect(servingCatalog.recipes.some(({ spec }) => spec.backend === "vllm")).toBe(true);
    expect(servingCatalog.recipes.some(({ spec }) => spec.backend === "install-llama-cpp")).toBe(
      true,
    );

    expectOnlyManagedVllmDefinitions(managedInferenceCatalogFromServingCatalog(servingCatalog));
  });

  it("excludes host-local definitions through the public managed loader (#8173)", () => {
    const projectedCatalog = managedInferenceCatalogFromServingCatalog(loadServingCatalog());
    const loadedCatalog = loadManagedInferenceCatalog();

    expect(loadedCatalog).toEqual(projectedCatalog);
    expectOnlyManagedVllmDefinitions(loadedCatalog);
  });
});
