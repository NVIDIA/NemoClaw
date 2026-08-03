// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import catalogSchema from "../../managed-inference/schemas/catalog.schema.json" with {
  type: "json",
};
import presetSchema from "../../managed-inference/schemas/preset.schema.json" with { type: "json" };
import recipeSchema from "../../managed-inference/schemas/recipe.schema.json" with { type: "json" };
import * as catalogIntegrityModule from "../../src/lib/inference/serving/catalog-integrity.ts";
import type {
  CompiledManagedInferenceCatalog,
  ManagedInferenceServingPreset,
  ManagedInferenceServingRecipe,
} from "../../src/lib/inference/serving/catalog-types.ts";
import * as catalogTypesModule from "../../src/lib/inference/serving/catalog-types.ts";

const compatibleCatalogIntegrityModule = catalogIntegrityModule as unknown as {
  default?: typeof catalogIntegrityModule;
};
const { canonicalManagedInferenceJson, managedInferenceDigest, managedInferenceTextDigest } =
  compatibleCatalogIntegrityModule.default ?? catalogIntegrityModule;
const compatibleCatalogTypesModule = catalogTypesModule as unknown as {
  default?: typeof catalogTypesModule;
};
const {
  DUAL_SPARK_PRESET_ID,
  DUAL_SPARK_RECIPE_ID,
  DUAL_SPARK_RECIPE_SPEC_DIGEST,
  isManagedInferenceMaterializerOwnedArgument,
  MANAGED_INFERENCE_CATALOG_COMPILER_VERSION,
  MANAGED_INFERENCE_CATALOG_SCHEMA_VERSION,
} = compatibleCatalogTypesModule.default ?? catalogTypesModule;

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_DIRECTORIES = ["managed-inference/presets", "managed-inference/recipes"] as const;
const GENERATED_CATALOG_PATH = "src/lib/inference/serving/generated/catalog.json";
const RECIPE_SCHEMA_ID = recipeSchema.$id;
const PRESET_SCHEMA_ID = presetSchema.$id;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface ManagedInferenceCatalogSource {
  readonly path: string;
  readonly contents: string;
}

export interface CompiledManagedInferenceCatalogResult {
  readonly catalog: CompiledManagedInferenceCatalog;
  readonly json: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validationError(label: string, validate: ValidateFunction): Error {
  const details = validate.errors
    ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
  return new Error(`${label} failed schema validation${details ? `: ${details}` : ""}`);
}

function parseYamlSource(source: ManagedInferenceCatalogSource): unknown {
  const document = parseDocument(source.contents, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${source.path} is invalid YAML: ${document.errors[0]?.message ?? "parse failed"}`,
    );
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(
      `${source.path} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function createValidators(): {
  validateCatalog: ValidateFunction;
  validatePreset: ValidateFunction;
  validateRecipe: ValidateFunction;
} {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
  ajv.addSchema(recipeSchema as AnySchema);
  ajv.addSchema(presetSchema as AnySchema);
  const validateRecipe = ajv.getSchema(RECIPE_SCHEMA_ID);
  const validatePreset = ajv.getSchema(PRESET_SCHEMA_ID);
  if (!validateRecipe || !validatePreset) throw new Error("managed inference schemas did not load");
  return {
    validateCatalog: ajv.compile(catalogSchema as AnySchema),
    validatePreset,
    validateRecipe,
  };
}

function validateRecipeSemantics(recipe: ManagedInferenceServingRecipe): void {
  if (recipe.metadata.id !== DUAL_SPARK_RECIPE_ID) {
    throw new Error(`unsupported serving recipe ${recipe.metadata.id}`);
  }
  if (!SHA256.test(recipe.spec.runtime.image.slice(recipe.spec.runtime.image.indexOf("@") + 1))) {
    throw new Error(`${recipe.metadata.id} must pin its runtime image by sha256 digest`);
  }
  const seenArguments = new Set<string>();
  for (const argument of recipe.spec.serve.arguments) {
    if (seenArguments.has(argument.name)) {
      throw new Error(`${recipe.metadata.id} contains duplicate serving argument ${argument.name}`);
    }
    if (isManagedInferenceMaterializerOwnedArgument(argument.name)) {
      throw new Error(`${recipe.metadata.id} assigns materializer-owned argument ${argument.name}`);
    }
    seenArguments.add(argument.name);
  }
  if (managedInferenceDigest(recipe.spec) !== DUAL_SPARK_RECIPE_SPEC_DIGEST) {
    throw new Error(`${recipe.metadata.id} contract changed without a new recipe ID`);
  }
}

function validatePresetSemantics(
  preset: ManagedInferenceServingPreset,
  recipes: ReadonlyMap<string, ManagedInferenceServingRecipe>,
): void {
  if (preset.metadata.id !== DUAL_SPARK_PRESET_ID) {
    throw new Error(`unsupported serving preset ${preset.metadata.id}`);
  }
  if (preset.spec.selection !== "automatic") {
    throw new Error(`${preset.metadata.id} must remain an automatic preset`);
  }
  const recipe = recipes.get(preset.spec.plan.recipeRef);
  if (!recipe)
    throw new Error(
      `${preset.metadata.id} references unknown recipe ${preset.spec.plan.recipeRef}`,
    );
  if (recipe.spec.backend !== preset.spec.plan.backend) {
    throw new Error(`${preset.metadata.id} backend does not match its recipe`);
  }

  const readinessRequirements = preset.spec.requirements.all.filter(
    (requirement) => "readiness" in requirement,
  );
  const nodeCountRequirements = preset.spec.requirements.all.filter(
    (requirement) => "fact" in requirement,
  );
  const topologyRequirements = preset.spec.requirements.all.filter(
    (requirement) => "topologyQualification" in requirement,
  );
  if (
    readinessRequirements.length !== 1 ||
    readinessRequirements[0]?.readiness.status !== "qualified"
  ) {
    throw new Error(
      `${preset.metadata.id} must require qualified DGX Spark readiness on every node`,
    );
  }
  if (
    nodeCountRequirements.length !== 1 ||
    nodeCountRequirements[0]?.state !== "present" ||
    nodeCountRequirements[0]?.value !== recipe.spec.execution.nodeCount
  ) {
    throw new Error(`${preset.metadata.id} must require the recipe's exact node count`);
  }
  const topology = topologyRequirements[0]?.topologyQualification;
  const recipeTopology = recipe.spec.bindings.sparkTopology;
  if (
    topologyRequirements.length !== 1 ||
    topology?.status !== "qualified" ||
    topology.id !== recipeTopology.qualificationId ||
    topology.schemaVersion !== recipeTopology.schemaVersion
  ) {
    throw new Error(`${preset.metadata.id} topology requirement does not match its recipe binding`);
  }
}

function sortedJson(value: unknown): unknown {
  return JSON.parse(canonicalManagedInferenceJson(value));
}

export function compileManagedInferenceCatalogSources(
  sources: readonly ManagedInferenceCatalogSource[],
): CompiledManagedInferenceCatalogResult {
  const sortedSources = [...sources].sort((left, right) => compareStrings(left.path, right.path));
  if (new Set(sortedSources.map((source) => source.path)).size !== sortedSources.length) {
    throw new Error("managed inference catalog contains a duplicate source path");
  }
  const { validateCatalog, validatePreset, validateRecipe } = createValidators();
  const recipes: {
    definition: ManagedInferenceServingRecipe;
    definitionDigest: string;
    sourceFile: string;
  }[] = [];
  const presets: {
    definition: ManagedInferenceServingPreset;
    definitionDigest: string;
    sourceFile: string;
  }[] = [];

  for (const source of sortedSources) {
    if (!/^managed-inference\/(?:presets|recipes)\/[a-z0-9._-]+\.yaml$/u.test(source.path)) {
      throw new Error(`unsupported managed inference source path ${source.path}`);
    }
    const parsed = parseYamlSource(source);
    const kind =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { readonly kind?: unknown }).kind
        : undefined;
    if (kind === "ServingRecipe") {
      if (!source.path.startsWith("managed-inference/recipes/") || !validateRecipe(parsed)) {
        throw validationError(source.path, validateRecipe);
      }
      recipes.push({
        definition: parsed as ManagedInferenceServingRecipe,
        definitionDigest: managedInferenceDigest(parsed),
        sourceFile: source.path,
      });
    } else if (kind === "ServingPreset") {
      if (!source.path.startsWith("managed-inference/presets/") || !validatePreset(parsed)) {
        throw validationError(source.path, validatePreset);
      }
      presets.push({
        definition: parsed as ManagedInferenceServingPreset,
        definitionDigest: managedInferenceDigest(parsed),
        sourceFile: source.path,
      });
    } else {
      throw new Error(`${source.path} has unsupported kind ${String(kind)}`);
    }
  }

  if (recipes.length !== 1 || presets.length !== 1) {
    throw new Error("managed inference catalog v1 requires exactly one recipe and one preset");
  }
  for (const { definition } of recipes) validateRecipeSemantics(definition);
  const recipesById = new Map(
    recipes.map(({ definition }) => [definition.metadata.id, definition]),
  );
  for (const { definition } of presets) validatePresetSemantics(definition, recipesById);

  const sourceFiles = sortedSources.map((source) => ({
    digest: managedInferenceTextDigest(source.contents),
    path: source.path,
  }));
  const withoutDigest = {
    compilerVersion: MANAGED_INFERENCE_CATALOG_COMPILER_VERSION,
    presets,
    recipes,
    schemaVersion: MANAGED_INFERENCE_CATALOG_SCHEMA_VERSION,
    sourceFiles,
    sourceRevision: managedInferenceDigest(sourceFiles),
  } as const;
  const catalog = sortedJson({
    ...withoutDigest,
    catalogDigest: managedInferenceDigest(withoutDigest),
  }) as CompiledManagedInferenceCatalog;
  if (!validateCatalog(catalog))
    throw validationError("compiled managed inference catalog", validateCatalog);
  return { catalog, json: `${JSON.stringify(catalog, null, 2)}\n` };
}

function readCatalogSources(repositoryRoot: string): ManagedInferenceCatalogSource[] {
  return SOURCE_DIRECTORIES.flatMap((directory) => {
    const absoluteDirectory = path.join(repositoryRoot, directory);
    return fs
      .readdirSync(absoluteDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => {
        const sourcePath = `${directory}/${entry.name}`;
        return {
          path: sourcePath,
          contents: fs.readFileSync(path.join(repositoryRoot, sourcePath), "utf8"),
        };
      });
  });
}

export function compileManagedInferenceCatalog(
  repositoryRoot = REPOSITORY_ROOT,
): CompiledManagedInferenceCatalogResult {
  return compileManagedInferenceCatalogSources(readCatalogSources(repositoryRoot));
}

function main(): void {
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--write");
  if (unknownArguments.length > 0) throw new Error(`unknown argument ${unknownArguments[0]}`);
  const { json } = compileManagedInferenceCatalog();
  const outputPath = path.join(REPOSITORY_ROOT, GENERATED_CATALOG_PATH);
  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, "utf8");
    return;
  }
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== json) throw new Error(`${GENERATED_CATALOG_PATH} is stale; rerun with --write`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
