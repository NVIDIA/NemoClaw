// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { posix } from "node:path";

import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import type {
  CompiledServingCatalog,
  CompiledServingCatalogPayload,
  ServingCatalogRegistries,
  ServingCatalogSchemas,
  ServingCatalogSource,
  ServingDefinitionKind,
  ServingPreset,
  ServingRecipe,
} from "./types";

const API_VERSION = "nemoclaw.nvidia.com/managed-inference/v1" as const;
const CATALOG_SCHEMA_VERSION = "1.0.0" as const;
const COMPILER_VERSION = "1.0.0" as const;
const READINESS_SCHEMA_REF =
  "https://github.com/NVIDIA/NemoClaw/schemas/system-readiness.schema.json" as const;
const RECIPE_SCHEMA_ID =
  "https://github.com/NVIDIA/NemoClaw/managed-inference/schemas/recipe.schema.json";
const PRESET_SCHEMA_ID =
  "https://github.com/NVIDIA/NemoClaw/managed-inference/schemas/preset.schema.json";
const CATALOG_SOURCE_PATTERN = /^managed-inference\/(recipes|presets)\/.+\.ya?ml$/;

interface CatalogValidators {
  catalog: ValidateFunction;
  preset: ValidateFunction;
  recipe: ValidateFunction;
}

interface CompileServingCatalogOptions {
  sources: readonly ServingCatalogSource[];
  sourceRevision: string;
  schemas: ServingCatalogSchemas;
  registries: ServingCatalogRegistries;
}

export class ServingCatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServingCatalogValidationError";
  }
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForCanonicalJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, nested]) => [key, normalizeForCanonicalJson(nested)]),
    );
  }
  return value;
}

export function canonicalServingCatalogJson(value: unknown): string {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalServingCatalogJson(value)).digest("hex")}`;
}

function createValidators(schemas: ServingCatalogSchemas): CatalogValidators {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schemas.recipe as AnySchema);
  ajv.addSchema(schemas.preset as AnySchema);
  const recipe = ajv.getSchema(RECIPE_SCHEMA_ID);
  const preset = ajv.getSchema(PRESET_SCHEMA_ID);
  if (!recipe || !preset) {
    throw new ServingCatalogValidationError("Serving catalog schemas have invalid identifiers.");
  }
  return {
    recipe,
    preset,
    catalog: ajv.compile(schemas.catalog as AnySchema),
  };
}

function validationDetails(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTrustedYaml(source: ServingCatalogSource): Record<string, unknown> {
  let document;
  try {
    document = parseDocument(source.contents, { strict: true, uniqueKeys: true });
  } catch (error) {
    throw new ServingCatalogValidationError(
      `${source.path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document.errors.length > 0) {
    throw new ServingCatalogValidationError(
      `${source.path} is not valid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new ServingCatalogValidationError(
      `${source.path} cannot use YAML aliases: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new ServingCatalogValidationError(`${source.path} must contain one YAML mapping.`);
  }
  return value;
}

function definitionIdentity(
  source: ServingCatalogSource,
  value: Record<string, unknown>,
): { kind: ServingDefinitionKind; id: string } {
  const kind = value.kind;
  const metadata = value.metadata;
  const id = isRecord(metadata) ? metadata.id : undefined;
  if ((kind !== "ServingRecipe" && kind !== "ServingPreset") || typeof id !== "string") {
    throw new ServingCatalogValidationError(
      `${source.path} must declare a ServingRecipe or ServingPreset with metadata.id.`,
    );
  }
  return { kind, id };
}

function validateRecipeSemantics(
  recipe: ServingRecipe,
  registries: ServingCatalogRegistries,
): void {
  const { materializerRef, lifecycleRef } = recipe.spec.execution;
  if (!registries.materializers.has(materializerRef)) {
    throw new ServingCatalogValidationError(
      `Recipe ${recipe.metadata.id} references unknown materializer ${materializerRef}.`,
    );
  }
  if (!registries.lifecycles.has(lifecycleRef)) {
    throw new ServingCatalogValidationError(
      `Recipe ${recipe.metadata.id} references unknown lifecycle adapter ${lifecycleRef}.`,
    );
  }

  const argumentNames = new Set<string>();
  for (const argument of recipe.spec.serve?.arguments ?? []) {
    if (argumentNames.has(argument.name)) {
      throw new ServingCatalogValidationError(
        `Recipe ${recipe.metadata.id} repeats structured argument ${argument.name}.`,
      );
    }
    argumentNames.add(argument.name);
  }

  const modelFiles = new Set<string>();
  for (const file of recipe.spec.model.files ?? []) {
    const normalizedPath = posix.normalize(file.path);
    if (normalizedPath !== file.path) {
      throw new ServingCatalogValidationError(
        `Recipe ${recipe.metadata.id} uses noncanonical model file path ${file.path}.`,
      );
    }
    if (modelFiles.has(normalizedPath)) {
      throw new ServingCatalogValidationError(
        `Recipe ${recipe.metadata.id} repeats model file ${normalizedPath}.`,
      );
    }
    modelFiles.add(normalizedPath);
  }
}

function validatePresetReadiness(
  preset: ServingPreset,
  registries: ServingCatalogRegistries,
): void {
  const requirements = new Set<string>();
  for (const requirement of preset.spec.requirements?.all ?? []) {
    const requirementKey = canonicalServingCatalogJson(requirement);
    if (requirements.has(requirementKey)) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} repeats readiness requirement ${requirementKey}.`,
      );
    }
    requirements.add(requirementKey);

    const registeredKind = registries.readiness.get(requirement.readiness.id);
    if (registeredKind === undefined) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} references unknown readiness entity ${requirement.readiness.id}.`,
      );
    }
    if (registeredKind !== requirement.readiness.kind) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} uses ${requirement.readiness.id} as ${requirement.readiness.kind}, but the readiness registry declares ${registeredKind}.`,
      );
    }
  }
}

function validateCatalogSemantics(
  recipes: readonly ServingRecipe[],
  presets: readonly ServingPreset[],
): void {
  const recipesById = new Map(recipes.map((recipe) => [recipe.metadata.id, recipe]));
  for (const preset of presets) {
    const recipe = recipesById.get(preset.spec.plan.recipeRef);
    if (!recipe) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} references unknown recipe ${preset.spec.plan.recipeRef}.`,
      );
    }
    if (recipe.spec.backend !== preset.spec.plan.backend) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} selects backend ${preset.spec.plan.backend}, but recipe ${recipe.metadata.id} uses ${recipe.spec.backend}.`,
      );
    }
  }

  const automaticSelectors = new Map<string, string>();
  for (const preset of presets) {
    if (preset.spec.selection !== "automatic") continue;
    const requirements = (preset.spec.requirements?.all ?? [])
      .map((requirement) => canonicalServingCatalogJson(requirement))
      .sort();
    const key = canonicalServingCatalogJson({
      backend: preset.spec.plan.backend,
      priority: preset.spec.priority,
      requirements,
    });
    const previous = automaticSelectors.get(key);
    if (previous) {
      throw new ServingCatalogValidationError(
        `Automatic presets ${previous} and ${preset.metadata.id} have the same selector at priority ${preset.spec.priority} for backend ${preset.spec.plan.backend}.`,
      );
    }
    automaticSelectors.set(key, preset.metadata.id);
  }
}

function catalogPayload(catalog: CompiledServingCatalog): CompiledServingCatalogPayload {
  const { catalogDigest: _catalogDigest, ...payload } = catalog;
  return payload;
}

export function compileTrustedServingCatalog(
  options: CompileServingCatalogOptions,
): CompiledServingCatalog {
  const validators = createValidators(options.schemas);
  const recipes: ServingRecipe[] = [];
  const presets: ServingPreset[] = [];
  const sources: CompiledServingCatalog["sources"] = [];
  const definitionIds = new Set<string>();
  const sourcePaths = new Set<string>();

  for (const source of [...options.sources].sort((left, right) =>
    compareCanonicalText(left.path, right.path),
  )) {
    const sourceMatch = CATALOG_SOURCE_PATTERN.exec(source.path);
    const hasUnsafeSegment = source.path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..");
    if (!sourceMatch || hasUnsafeSegment) {
      throw new ServingCatalogValidationError(
        `Catalog source ${source.path} is outside managed-inference/recipes or managed-inference/presets.`,
      );
    }
    if (sourcePaths.has(source.path)) {
      throw new ServingCatalogValidationError(`Catalog source path ${source.path} is duplicated.`);
    }
    sourcePaths.add(source.path);

    const value = parseTrustedYaml(source);
    const { kind, id } = definitionIdentity(source, value);
    const expectedDirectory = kind === "ServingRecipe" ? "recipes" : "presets";
    if (sourceMatch[1] !== expectedDirectory) {
      throw new ServingCatalogValidationError(
        `${source.path} must place ${kind} definitions under managed-inference/${expectedDirectory}.`,
      );
    }
    const validate = kind === "ServingRecipe" ? validators.recipe : validators.preset;
    if (!validate(value)) {
      throw new ServingCatalogValidationError(
        `${source.path} does not satisfy the ${kind} schema: ${validationDetails(validate)}`,
      );
    }
    if (definitionIds.has(id)) {
      throw new ServingCatalogValidationError(`Serving definition ID ${id} is duplicated.`);
    }
    definitionIds.add(id);

    if (kind === "ServingRecipe") {
      const recipe = value as unknown as ServingRecipe;
      validateRecipeSemantics(recipe, options.registries);
      recipes.push(recipe);
    } else {
      const preset = value as unknown as ServingPreset;
      validatePresetReadiness(preset, options.registries);
      presets.push(preset);
    }
    sources.push({ path: source.path, kind, id, digest: digest(value) });
  }

  recipes.sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  presets.sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  validateCatalogSemantics(recipes, presets);

  const payload: CompiledServingCatalogPayload = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    sourceRevision: options.sourceRevision,
    readinessSchemaRef: READINESS_SCHEMA_REF,
    recipes,
    presets,
    sources,
  };
  const catalog: CompiledServingCatalog = { ...payload, catalogDigest: digest(payload) };
  if (!validators.catalog(catalog)) {
    throw new ServingCatalogValidationError(
      `Compiled serving catalog is invalid: ${validationDetails(validators.catalog)}`,
    );
  }
  return catalog;
}

export function parseCompiledServingCatalogJson(
  source: string,
  schemas: ServingCatalogSchemas,
): CompiledServingCatalog {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ServingCatalogValidationError(
      `Compiled serving catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validators = createValidators(schemas);
  if (!validators.catalog(value)) {
    throw new ServingCatalogValidationError(
      `Compiled serving catalog is invalid: ${validationDetails(validators.catalog)}`,
    );
  }
  const catalog = value as CompiledServingCatalog;
  const expectedDigest = digest(catalogPayload(catalog));
  if (catalog.catalogDigest !== expectedDigest) {
    throw new ServingCatalogValidationError(
      `Compiled serving catalog digest mismatch: expected ${expectedDigest}.`,
    );
  }
  return catalog;
}

export function serializeCompiledServingCatalog(catalog: CompiledServingCatalog): string {
  return `${canonicalServingCatalogJson(catalog)}\n`;
}

export const servingCatalogContract = Object.freeze({
  apiVersion: API_VERSION,
  catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
  compilerVersion: COMPILER_VERSION,
  readinessSchemaRef: READINESS_SCHEMA_REF,
});
