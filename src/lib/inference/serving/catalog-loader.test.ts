// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MANAGED_CLUSTER_VLLM_LIFECYCLE_REF,
  MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
} from "./adapter-registry";
import { assertManagedInferenceCatalog } from "./catalog-loader";
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

function managedCatalogValidationError(catalog: CompiledServingCatalog): string | undefined {
  try {
    assertManagedInferenceCatalog(catalog);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
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
});
