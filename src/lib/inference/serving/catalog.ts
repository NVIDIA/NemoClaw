// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { immutableManagedInferenceCopy, managedInferenceDigest } from "./catalog-integrity.js";
import {
  type CompiledManagedInferenceCatalog,
  DUAL_SPARK_PRESET_ID,
  DUAL_SPARK_RECIPE_ID,
  DUAL_SPARK_RECIPE_SPEC_DIGEST,
  MANAGED_INFERENCE_CATALOG_COMPILER_VERSION,
  MANAGED_INFERENCE_CATALOG_SCHEMA_VERSION,
} from "./catalog-types.js";
import generatedCatalog from "./generated/catalog.json";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function assertCatalogIntegrity(value: unknown): asserts value is CompiledManagedInferenceCatalog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("managed inference catalog must be an object");
  }
  const catalog = value as Partial<CompiledManagedInferenceCatalog>;
  if (
    catalog.schemaVersion !== MANAGED_INFERENCE_CATALOG_SCHEMA_VERSION ||
    catalog.compilerVersion !== MANAGED_INFERENCE_CATALOG_COMPILER_VERSION
  ) {
    throw new Error("managed inference catalog version is unsupported");
  }
  if (!SHA256.test(catalog.catalogDigest ?? "") || !SHA256.test(catalog.sourceRevision ?? "")) {
    throw new Error("managed inference catalog provenance is invalid");
  }
  if (
    !Array.isArray(catalog.sourceFiles) ||
    !Array.isArray(catalog.recipes) ||
    !Array.isArray(catalog.presets)
  ) {
    throw new Error("managed inference catalog definitions are invalid");
  }

  const { catalogDigest, ...withoutDigest } = catalog as CompiledManagedInferenceCatalog;
  if (managedInferenceDigest(withoutDigest) !== catalogDigest) {
    throw new Error("managed inference catalog digest does not match its contents");
  }
  if (managedInferenceDigest(catalog.sourceFiles) !== catalog.sourceRevision) {
    throw new Error("managed inference catalog source revision does not match its provenance");
  }
  if (catalog.recipes.length !== 1 || catalog.presets.length !== 1) {
    throw new Error("managed inference catalog must contain the supported recipe and preset");
  }

  const recipe = catalog.recipes[0];
  const preset = catalog.presets[0];
  if (
    !recipe ||
    !preset ||
    recipe.definition.metadata.id !== DUAL_SPARK_RECIPE_ID ||
    preset.definition.metadata.id !== DUAL_SPARK_PRESET_ID
  ) {
    throw new Error("managed inference catalog contains an unsupported definition");
  }
  if (managedInferenceDigest(recipe.definition.spec) !== DUAL_SPARK_RECIPE_SPEC_DIGEST) {
    throw new Error("managed inference recipe ID does not match its immutable contract");
  }
  for (const compiled of [recipe, preset]) {
    if (
      !SHA256.test(compiled.definitionDigest) ||
      compiled.definitionDigest !== managedInferenceDigest(compiled.definition) ||
      !catalog.sourceFiles.some(({ path }) => path === compiled.sourceFile)
    ) {
      throw new Error(`managed inference definition ${compiled.definition.metadata.id} is invalid`);
    }
  }
  if (preset.definition.spec.plan.recipeRef !== recipe.definition.metadata.id) {
    throw new Error("managed inference preset references an unknown recipe");
  }
}

let loadedCatalog: CompiledManagedInferenceCatalog | undefined;

export function loadManagedInferenceCatalog(): CompiledManagedInferenceCatalog {
  if (loadedCatalog) return loadedCatalog;
  assertCatalogIntegrity(generatedCatalog);
  loadedCatalog = immutableManagedInferenceCopy(generatedCatalog);
  return loadedCatalog;
}
