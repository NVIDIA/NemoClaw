// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getManagedInferenceRecipeRegistrationError,
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
  MANAGED_CLUSTER_VLLM_LIFECYCLE_REF,
  MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
} from "./adapter-registry.js";
import { parseCompiledServingCatalogJson, servingCatalogDigest } from "./catalog.js";
import { immutableManagedInferenceCopy } from "./catalog-integrity.js";
import type {
  CompiledManagedInferenceCatalog,
  CompiledServingCatalog,
  ManagedInferenceRuntimeServingRecipe,
  ManagedInferenceServingPreset,
  ServingCatalogSchemas,
  ServingPreset,
  ServingRecipe,
} from "./types.js";

function readJson(path: string): object {
  return JSON.parse(readFileSync(path, "utf8")) as object;
}

function repositoryRoot(): string {
  return join(__dirname, "..", "..", "..", "..");
}

function loadSchemas(rootDir: string): ServingCatalogSchemas {
  const schemaRoot = join(rootDir, "managed-inference", "schemas");
  return {
    catalog: readJson(join(schemaRoot, "catalog.schema.json")),
    preset: readJson(join(schemaRoot, "preset.schema.json")),
    recipe: readJson(join(schemaRoot, "recipe.schema.json")),
  };
}

let loadedServingCatalog: CompiledServingCatalog | undefined;
let loadedManagedCatalog: CompiledManagedInferenceCatalog | undefined;

function assertManagedRecipe(
  recipe: ServingRecipe,
): asserts recipe is ManagedInferenceRuntimeServingRecipe {
  let registrationError: string | undefined;
  try {
    registrationError = getManagedInferenceRecipeRegistrationError(
      recipe as ManagedInferenceRuntimeServingRecipe,
    );
  } catch {
    registrationError = "does not satisfy its registered adapter contract";
  }
  if (registrationError) {
    throw new Error(`Managed inference recipe ${recipe.metadata.id}: ${registrationError}`);
  }
}

function assertManagedPreset(
  preset: ServingPreset,
): asserts preset is ManagedInferenceServingPreset {
  if (!preset.spec.requirements) {
    throw new Error(`Managed inference preset ${preset.metadata.id} must declare requirements`);
  }
}

/** Narrow a generic serving catalog to the currently supported managed runtime surface. */
export function assertManagedInferenceCatalog(
  catalog: CompiledServingCatalog,
): asserts catalog is CompiledManagedInferenceCatalog {
  for (const recipe of catalog.recipes) assertManagedRecipe(recipe);
  for (const preset of catalog.presets) {
    assertManagedPreset(preset);
    const recipes = catalog.recipes.filter(
      ({ metadata }) => metadata.id === preset.spec.plan.recipeRef,
    );
    if (recipes.length !== 1 || recipes[0]!.spec.backend !== preset.spec.plan.backend) {
      throw new Error(
        `Managed inference preset ${preset.metadata.id} does not resolve one matching recipe`,
      );
    }
  }
}

export function parseCompiledManagedInferenceCatalogJson(
  source: string,
  schemas: ServingCatalogSchemas,
): CompiledManagedInferenceCatalog {
  const catalog = parseCompiledServingCatalogJson(source, schemas);
  assertManagedInferenceCatalog(catalog);
  return catalog;
}

function isManagedInferenceRecipeCandidate(
  recipe: ServingRecipe,
): recipe is ManagedInferenceRuntimeServingRecipe {
  return (
    recipe.spec.execution.materializerRef === MANAGED_CLUSTER_VLLM_MATERIALIZER_REF ||
    recipe.spec.execution.lifecycleRef === MANAGED_CLUSTER_VLLM_LIFECYCLE_REF ||
    recipe.spec.execution.materializerRef === HOST_LOCAL_VLLM_MATERIALIZER_REF ||
    recipe.spec.execution.lifecycleRef === HOST_LOCAL_VLLM_LIFECYCLE_REF
  );
}

/** Project recipes backed by a registered NemoClaw-managed vLLM runtime. */
export function managedInferenceCatalogFromServingCatalog(
  catalog: CompiledServingCatalog,
): CompiledManagedInferenceCatalog {
  const recipes = catalog.recipes.filter(isManagedInferenceRecipeCandidate);
  const recipeIds = new Set(recipes.map(({ metadata }) => metadata.id));
  const presets = catalog.presets.filter((preset) => recipeIds.has(preset.spec.plan.recipeRef));
  const definitionIds = new Set([...recipeIds, ...presets.map(({ metadata }) => metadata.id)]);
  const sources = catalog.sources.filter(({ id }) => definitionIds.has(id));
  const { catalogDigest: _catalogDigest, ...catalogContents } = catalog;
  const payload = { ...catalogContents, recipes, presets, sources };
  const managedCatalog = { ...payload, catalogDigest: servingCatalogDigest(payload) };
  assertManagedInferenceCatalog(managedCatalog);
  return managedCatalog;
}

export function loadServingCatalog(): CompiledServingCatalog {
  if (loadedServingCatalog) return loadedServingCatalog;
  const rootDir = repositoryRoot();
  const source = readFileSync(join(rootDir, "dist", "managed-inference", "catalog.json"), "utf8");
  loadedServingCatalog = immutableManagedInferenceCopy(
    parseCompiledServingCatalogJson(source, loadSchemas(rootDir)),
  );
  return loadedServingCatalog;
}

export function loadManagedInferenceCatalog(): CompiledManagedInferenceCatalog {
  if (loadedManagedCatalog) return loadedManagedCatalog;
  loadedManagedCatalog = immutableManagedInferenceCopy(
    managedInferenceCatalogFromServingCatalog(loadServingCatalog()),
  );
  return loadedManagedCatalog;
}

export function getCompiledServingPreset(id: string): ServingPreset | undefined {
  return loadServingCatalog().presets.find(({ metadata }) => metadata.id === id);
}

export function getCompiledServingRecipe(id: string): ServingRecipe | undefined {
  return loadServingCatalog().recipes.find(({ metadata }) => metadata.id === id);
}

export function getManagedInferenceCompiledPreset(
  id: string,
): ManagedInferenceServingPreset | undefined {
  return loadManagedInferenceCatalog().presets.find(({ metadata }) => metadata.id === id);
}

export function getManagedInferenceCompiledRecipe(
  id: string,
): ManagedInferenceRuntimeServingRecipe | undefined {
  return loadManagedInferenceCatalog().recipes.find(({ metadata }) => metadata.id === id);
}
