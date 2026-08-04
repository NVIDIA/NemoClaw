// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { immutableManagedInferenceCopy } from "./catalog-integrity.js";
import { parseCompiledServingCatalogJson } from "./catalog.js";
import type {
  CompiledManagedInferenceCatalog,
  ManagedInferenceServingPreset,
  ManagedInferenceServingRecipe,
  ServingCatalogSchemas,
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

export function loadManagedInferenceCatalog(): CompiledManagedInferenceCatalog {
  if (loadedCatalog) return loadedCatalog;
  const rootDir = repositoryRoot();
  const source = readFileSync(join(rootDir, "dist", "managed-inference", "catalog.json"), "utf8");
  loadedCatalog = immutableManagedInferenceCopy(
    parseCompiledServingCatalogJson(source, loadSchemas(rootDir)),
  ) as CompiledManagedInferenceCatalog;
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
