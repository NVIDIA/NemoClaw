// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getManagedInferenceRecipeRegistrationError } from "./adapter-registry.js";
import { parseCompiledServingCatalogJson } from "./catalog.js";
import { immutableManagedInferenceCopy } from "./catalog-integrity.js";
import type {
  CompiledManagedInferenceCatalog,
  CompiledServingCatalog,
  ManagedInferenceServingPreset,
  ManagedInferenceServingRecipe,
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

let loadedCatalog: CompiledManagedInferenceCatalog | undefined;

function assertManagedRecipe(
  recipe: ServingRecipe,
): asserts recipe is ManagedInferenceServingRecipe {
  let registrationError: string | undefined;
  try {
    registrationError = getManagedInferenceRecipeRegistrationError(
      recipe as ManagedInferenceServingRecipe,
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
  if (!preset.spec.requirements || !preset.spec.plan.bindings) {
    throw new Error(
      `Managed inference preset ${preset.metadata.id} must declare requirements and topology bindings`,
    );
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

export function loadManagedInferenceCatalog(): CompiledManagedInferenceCatalog {
  if (loadedCatalog) return loadedCatalog;
  const rootDir = repositoryRoot();
  const source = readFileSync(join(rootDir, "dist", "managed-inference", "catalog.json"), "utf8");
  loadedCatalog = immutableManagedInferenceCopy(
    parseCompiledManagedInferenceCatalogJson(source, loadSchemas(rootDir)),
  );
  return loadedCatalog;
}

export function getManagedInferenceCompiledPreset(
  id: string,
): ManagedInferenceServingPreset | undefined {
  return loadManagedInferenceCatalog().presets.find(({ metadata }) => metadata.id === id);
}

export function getManagedInferenceCompiledRecipe(
  id: string,
): ManagedInferenceServingRecipe | undefined {
  return loadManagedInferenceCatalog().recipes.find(({ metadata }) => metadata.id === id);
}
