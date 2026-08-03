// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getManagedInferenceRecipeRegistrationError,
  getManagedInferenceTopologyQualificationDescriptor,
} from "./adapter-registry.js";
import { immutableManagedInferenceCopy, managedInferenceDigest } from "./catalog-integrity.js";
import {
  type CompiledManagedInferenceCatalog,
  MANAGED_INFERENCE_CATALOG_COMPILER_VERSION,
  MANAGED_INFERENCE_CATALOG_SCHEMA_VERSION,
  type ManagedInferenceServingPreset,
  type ManagedInferenceServingRecipe,
} from "./catalog-types.js";
import generatedCatalog from "./generated/catalog.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_PATH = /^managed-inference\/(?:presets|recipes)\/[a-z0-9._-]+\.yaml$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function definitionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = value.metadata;
  if (!isRecord(metadata)) return undefined;
  return typeof metadata.id === "string" && metadata.id.length > 0 ? metadata.id : undefined;
}

function assertCompiledDefinitions(
  definitions:
    | CompiledManagedInferenceCatalog["presets"]
    | CompiledManagedInferenceCatalog["recipes"],
  kind: "ServingPreset" | "ServingRecipe",
  sourceDirectory: "presets" | "recipes",
  sourcePaths: ReadonlySet<string>,
  seenIds: Set<string>,
  seenSources: Set<string>,
): void {
  for (const compiled of definitions) {
    const id = definitionId(compiled.definition);
    if (
      !id ||
      !isRecord(compiled.definition) ||
      compiled.definition.kind !== kind ||
      seenIds.has(id) ||
      !SHA256.test(compiled.definitionDigest) ||
      compiled.definitionDigest !== managedInferenceDigest(compiled.definition) ||
      typeof compiled.sourceFile !== "string" ||
      !compiled.sourceFile.startsWith(`managed-inference/${sourceDirectory}/`) ||
      !sourcePaths.has(compiled.sourceFile) ||
      seenSources.has(compiled.sourceFile)
    ) {
      throw new Error(`managed inference ${kind} definition is invalid`);
    }
    seenIds.add(id);
    seenSources.add(compiled.sourceFile);
  }
}

function assertReferences(
  presets: readonly { readonly definition: ManagedInferenceServingPreset }[],
  recipes: readonly { readonly definition: ManagedInferenceServingRecipe }[],
): void {
  const recipesById = new Map(
    recipes.map(({ definition }) => [definition.metadata.id, definition]),
  );
  for (const { definition: recipe } of recipes) {
    const registrationError = getManagedInferenceRecipeRegistrationError(recipe);
    if (registrationError) {
      throw new Error(
        `managed inference recipe ${recipe.metadata.id} is incompatible with its registered adapters: ${registrationError}`,
      );
    }
  }
  for (const { definition: preset } of presets) {
    const recipe = recipesById.get(preset.spec.plan.recipeRef);
    if (!recipe || recipe.spec.backend !== preset.spec.plan.backend) {
      throw new Error(
        `managed inference preset ${preset.metadata.id} has an invalid recipe reference`,
      );
    }
    const recipeBindings = Object.keys(recipe.spec.bindings).sort();
    const presetBindings = Object.keys(preset.spec.plan.bindings).sort();
    if (
      recipeBindings.length !== presetBindings.length ||
      recipeBindings.some((name, index) => name !== presetBindings[index])
    ) {
      throw new Error(`managed inference preset ${preset.metadata.id} has invalid bindings`);
    }
    for (const name of recipeBindings) {
      const expected = recipe.spec.bindings[name]!;
      const actual = preset.spec.plan.bindings[name]!.valueFromTopologyQualification;
      const descriptor = getManagedInferenceTopologyQualificationDescriptor(
        expected.qualificationId,
        expected.schemaVersion,
      );
      if (
        !descriptor ||
        actual.id !== expected.qualificationId ||
        actual.schemaVersion !== expected.schemaVersion ||
        actual.output !== descriptor.bindingOutput
      ) {
        throw new Error(
          `managed inference preset ${preset.metadata.id} has invalid binding ${name}`,
        );
      }
    }
  }
}

function assertCatalogIntegrity(value: unknown): asserts value is CompiledManagedInferenceCatalog {
  if (!isRecord(value)) throw new Error("managed inference catalog must be an object");
  const catalog = value as unknown as Partial<CompiledManagedInferenceCatalog>;
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
    !Array.isArray(catalog.presets) ||
    catalog.recipes.length === 0 ||
    catalog.presets.length === 0
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
  const sourcePaths = new Set<string>();
  for (const source of catalog.sourceFiles) {
    if (
      !isRecord(source) ||
      typeof source.path !== "string" ||
      !SOURCE_PATH.test(source.path) ||
      sourcePaths.has(source.path) ||
      typeof source.digest !== "string" ||
      !SHA256.test(source.digest)
    ) {
      throw new Error("managed inference catalog source provenance is invalid");
    }
    sourcePaths.add(source.path);
  }
  if (sourcePaths.size !== catalog.recipes.length + catalog.presets.length) {
    throw new Error("managed inference catalog source provenance is incomplete");
  }

  const seenIds = new Set<string>();
  const seenSources = new Set<string>();
  assertCompiledDefinitions(
    catalog.recipes,
    "ServingRecipe",
    "recipes",
    sourcePaths,
    seenIds,
    seenSources,
  );
  assertCompiledDefinitions(
    catalog.presets,
    "ServingPreset",
    "presets",
    sourcePaths,
    seenIds,
    seenSources,
  );
  assertReferences(catalog.presets, catalog.recipes);
}

let loadedCatalog: CompiledManagedInferenceCatalog | undefined;

export function loadManagedInferenceCatalog(): CompiledManagedInferenceCatalog {
  if (loadedCatalog) return loadedCatalog;
  assertCatalogIntegrity(generatedCatalog);
  loadedCatalog = immutableManagedInferenceCopy(generatedCatalog);
  return loadedCatalog;
}

export function getManagedInferenceCompiledPreset(
  id: string,
): CompiledManagedInferenceCatalog["presets"][number] | undefined {
  return loadManagedInferenceCatalog().presets.find(
    ({ definition }) => definition.metadata.id === id,
  );
}

export function getManagedInferenceCompiledRecipe(
  id: string,
): CompiledManagedInferenceCatalog["recipes"][number] | undefined {
  return loadManagedInferenceCatalog().recipes.find(
    ({ definition }) => definition.metadata.id === id,
  );
}
