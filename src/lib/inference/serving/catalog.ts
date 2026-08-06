// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { posix } from "node:path";

import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import { compileLlamaCppGgufCachePlan } from "../llama-cpp/gguf-cache-plan";
import type {
  CompiledServingCatalog,
  CompiledServingCatalogPayload,
  LlamaCppServingRecipe,
  ServingCatalogRegistries,
  ServingCatalogSchemas,
  ServingCatalogSource,
  ServingCatalogSourceProvenance,
  ServingDefinitionKind,
  ServingPreset,
  ServingReadinessComparison,
  ServingReadinessObservationRole,
  ServingReadinessRegistryEntry,
  ServingReadinessRegistryValue,
  ServingReadinessRequirement,
  ServingRecipe,
} from "./types";

const API_VERSION = "nemoclaw.nvidia.com/managed-inference/v1" as const;
const CATALOG_SCHEMA_VERSION = "1.0.0" as const;
const COMPILER_VERSION = "1.2.0" as const;
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
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
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

export function servingCatalogDigest(value: unknown): string {
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
  return { recipe, preset, catalog: ajv.compile(schemas.catalog as AnySchema) };
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

function isLlamaCppServingRecipe(recipe: ServingRecipe): recipe is LlamaCppServingRecipe {
  return recipe.spec.providerId === "llama-cpp-local";
}

function isReadinessRegistryEntry(
  registered: ServingReadinessRegistryValue,
): registered is ServingReadinessRegistryEntry {
  return typeof registered === "object" && registered !== null && "kind" in registered;
}

function readinessKindMatches(
  registered: ServingReadinessRegistryValue,
  kind: ServingReadinessRequirement["readiness"]["kind"],
): boolean {
  if (typeof registered === "string") return registered === kind;
  if (isReadinessRegistryEntry(registered)) return registered.kind === kind;
  return registered.has(kind);
}

function readinessKindLabel(registered: ServingReadinessRegistryValue): string {
  if (typeof registered === "string") return registered;
  if (isReadinessRegistryEntry(registered)) return registered.kind;
  return [...registered].join(" or ");
}

function readinessDescriptor(
  registered: ServingReadinessRegistryValue | undefined,
  kind: ServingReadinessRequirement["readiness"]["kind"],
): ServingReadinessRegistryEntry | undefined {
  if (registered === undefined || !readinessKindMatches(registered, kind)) return undefined;
  return isReadinessRegistryEntry(registered) ? registered : { kind };
}

function validateRecipeSemantics(
  recipe: ServingRecipe,
  registries: ServingCatalogRegistries,
): void {
  const { receiptRef, materializerRef, lifecycleRef } = recipe.spec.execution;
  if (receiptRef && !registries.receipts.has(receiptRef)) {
    throw new ServingCatalogValidationError(
      `Recipe ${recipe.metadata.id} references unknown receipt contract ${receiptRef}.`,
    );
  }
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

  const readinessContractRef = recipe.spec.readiness?.contractRef;
  if (readinessContractRef && !registries.readinessContracts.has(readinessContractRef)) {
    throw new ServingCatalogValidationError(
      `Recipe ${recipe.metadata.id} references unknown readiness contract ${readinessContractRef}.`,
    );
  }

  if (!isLlamaCppServingRecipe(recipe)) {
    const argumentNames = new Set<string>();
    for (const argument of recipe.spec.serve?.arguments ?? []) {
      if (argumentNames.has(argument.name)) {
        throw new ServingCatalogValidationError(
          `Recipe ${recipe.metadata.id} repeats structured argument ${argument.name}.`,
        );
      }
      argumentNames.add(argument.name);
    }
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

  if (isLlamaCppServingRecipe(recipe)) {
    try {
      compileLlamaCppGgufCachePlan(recipe);
    } catch (error) {
      throw new ServingCatalogValidationError(
        `Recipe ${recipe.metadata.id}: ${error instanceof Error ? error.message : "GGUF cache plan compilation failed."}`,
      );
    }
    const servedName = recipe.spec.model.servedName;
    if (recipe.spec.readiness.expectedModel !== servedName) {
      throw new ServingCatalogValidationError(
        `Recipe ${recipe.metadata.id} readiness expectedModel must match model servedName.`,
      );
    }
    const { serve } = recipe.spec;
    if (serve.limits.maxPromptTokens + serve.limits.maxCompletionTokens > serve.contextSize) {
      throw new ServingCatalogValidationError(
        `Recipe ${recipe.metadata.id} request token limits exceed serve.contextSize.`,
      );
    }
    if (serve.microBatchSize > serve.batchSize) {
      throw new ServingCatalogValidationError(
        `Recipe ${recipe.metadata.id} serve.microBatchSize cannot exceed serve.batchSize.`,
      );
    }
    const agents = new Set<string>();
    for (const agent of recipe.spec.capabilities.agents) {
      if (agents.has(agent.id)) {
        throw new ServingCatalogValidationError(
          `Recipe ${recipe.metadata.id} repeats agent capability ${agent.id}.`,
        );
      }
      agents.add(agent.id);
      if (!readinessDescriptor(registries.readiness.get(agent.qualificationRef), "qualification")) {
        throw new ServingCatalogValidationError(
          `Recipe ${recipe.metadata.id} references unknown agent qualification ${agent.qualificationRef} for ${agent.id}.`,
        );
      }
    }
  }

  let registrationError: string | undefined;
  try {
    registrationError = registries.validateRecipe?.(recipe);
  } catch {
    registrationError = "does not satisfy its registered adapter contract";
  }
  if (registrationError) {
    throw new ServingCatalogValidationError(`Recipe ${recipe.metadata.id}: ${registrationError}.`);
  }
}

function comparisonValueType(
  comparison: ServingReadinessComparison,
): "boolean" | "number" | "string" | "version" | "mixed" {
  if (comparison.operator === "at-least") return "number";
  if (comparison.operator === "version-at-least") return "version";
  const values = comparison.operator === "one-of" ? comparison.values : [comparison.value];
  const types = new Set(values.map((value) => typeof value));
  if (types.size !== 1) return "mixed";
  const [type] = types;
  return type === "boolean" || type === "number" || type === "string" ? type : "mixed";
}

function readinessRequirementKey(requirement: ServingReadinessRequirement): string {
  const readiness = requirement.readiness;
  return `${readiness.scope}:${readiness.kind}:${readiness.id}`;
}

function validatePresetRequirements(
  preset: ServingPreset,
  registries: ServingCatalogRegistries,
): void {
  const requirements = new Set<string>();
  const requirementsByEntity = new Map<string, string>();
  for (const requirement of preset.spec.requirements?.all ?? []) {
    const requirementKey = canonicalServingCatalogJson(requirement);
    if (requirements.has(requirementKey)) {
      const requirementLabel = "readiness" in requirement ? "readiness requirement" : "requirement";
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} repeats ${requirementLabel} ${requirementKey}.`,
      );
    }
    requirements.add(requirementKey);

    if ("readiness" in requirement) {
      const { readiness } = requirement;
      const registered = registries.readiness.get(readiness.id);
      if (registered === undefined) {
        throw new ServingCatalogValidationError(
          `Preset ${preset.metadata.id} references unknown readiness entity ${readiness.id}.`,
        );
      }
      if (!readinessKindMatches(registered, readiness.kind)) {
        throw new ServingCatalogValidationError(
          `Preset ${preset.metadata.id} uses ${readiness.id} as ${readiness.kind}, but the readiness registry declares ${readinessKindLabel(registered)}.`,
        );
      }

      if ("comparison" in readiness) {
        const descriptor = readinessDescriptor(registered, readiness.kind);
        const comparisonType = comparisonValueType(readiness.comparison);
        if (!descriptor?.valueType || comparisonType !== descriptor.valueType) {
          throw new ServingCatalogValidationError(
            `Preset ${preset.metadata.id} compares ${readiness.id} as ${comparisonType}, but the readiness registry declares ${descriptor?.valueType ?? "no value type"}.`,
          );
        }
      }

      const key = readinessRequirementKey(requirement);
      const previous = requirementsByEntity.get(key);
      if (previous !== undefined && previous !== requirementKey) {
        throw new ServingCatalogValidationError(
          `Preset ${preset.metadata.id} has contradictory readiness requirements for ${key}.`,
        );
      }
      requirementsByEntity.set(key, requirementKey);
      continue;
    }
    if ("fact" in requirement) {
      if (registries.facts && !registries.facts.has(requirement.fact)) {
        throw new ServingCatalogValidationError(
          `Preset ${preset.metadata.id} references unknown selection fact ${requirement.fact}.`,
        );
      }
      continue;
    }
    const key = `${requirement.topologyQualification.id}@${String(requirement.topologyQualification.schemaVersion)}`;
    if (registries.topologyQualifications && !registries.topologyQualifications.has(key)) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} references unknown topology qualification ${key}.`,
      );
    }
  }
}

function canonicalReadinessComparison(comparison: ServingReadinessComparison): string {
  if (comparison.operator !== "one-of") return canonicalServingCatalogJson(comparison);
  return canonicalServingCatalogJson({
    ...comparison,
    values: [...comparison.values].sort((left, right) =>
      compareCanonicalText(canonicalServingCatalogJson(left), canonicalServingCatalogJson(right)),
    ),
  });
}

function llamaCppReadinessComparisonMatches(
  recipe: LlamaCppServingRecipe,
  role: ServingReadinessObservationRole,
  actual: ServingReadinessComparison,
  expected: ServingReadinessComparison,
): boolean {
  if (role !== "architecture" || actual.operator !== "equals") {
    return canonicalReadinessComparison(actual) === canonicalReadinessComparison(expected);
  }
  return (
    typeof actual.value === "string" &&
    recipe.spec.runtime.platforms.includes(
      `linux/${actual.value}` as LlamaCppServingRecipe["spec"]["runtime"]["platforms"][number],
    )
  );
}

function validateLlamaCppPreset(
  recipe: LlamaCppServingRecipe,
  preset: ServingPreset,
  registries: ServingCatalogRegistries,
): void {
  const expectedComparisons = new Map<ServingReadinessObservationRole, ServingReadinessComparison>([
    ["operating-system", { operator: "equals", value: "linux" }],
    [
      "architecture",
      {
        operator: "one-of",
        values: recipe.spec.runtime.platforms.map((platform) => platform.slice("linux/".length)),
      },
    ],
    ["container-runtime", { operator: "equals", value: recipe.spec.runtime.containerRuntime }],
    ["gpu-count", { operator: "at-least", value: recipe.spec.runtime.gpu.count }],
    [
      "driver-version",
      { operator: "version-at-least", value: recipe.spec.runtime.cuda.minimumDriverVersion },
    ],
  ]);
  const seenRoles = new Set<ServingReadinessObservationRole>();
  const qualified = new Set<string>();

  for (const requirement of preset.spec.requirements?.all ?? []) {
    if (!("readiness" in requirement)) continue;
    const { readiness } = requirement;
    if (readiness.kind === "qualification" && readiness.status === "qualified") {
      qualified.add(readiness.id);
    }
    const registered = registries.readiness.get(readiness.id);
    if (registered === undefined || !isReadinessRegistryEntry(registered)) continue;
    if (registered.kind !== "observation" || registered.role === undefined) continue;
    const expected = expectedComparisons.get(registered.role);
    if (!expected) continue;
    if (seenRoles.has(registered.role)) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} repeats llama.cpp readiness role ${registered.role}.`,
      );
    }
    seenRoles.add(registered.role);
    if (
      !("comparison" in readiness) ||
      !llamaCppReadinessComparisonMatches(recipe, registered.role, readiness.comparison, expected)
    ) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} must require ${registered.role} matching llama.cpp recipe ${recipe.metadata.id}.`,
      );
    }
  }

  for (const role of expectedComparisons.keys()) {
    if (!seenRoles.has(role)) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} must require ${role} matching llama.cpp recipe ${recipe.metadata.id}.`,
      );
    }
  }
  for (const agent of recipe.spec.capabilities.agents) {
    if (!qualified.has(agent.qualificationRef)) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} must require qualified status for ${agent.qualificationRef} before selecting llama.cpp recipe ${recipe.metadata.id}.`,
      );
    }
  }
}

function validateBindings(
  preset: ServingPreset,
  recipe: ServingRecipe,
  registries: ServingCatalogRegistries,
): void {
  const recipeBindingsByName = recipe.spec.bindings ?? {};
  const presetBindingsByName = preset.spec.plan.bindings ?? {};
  const recipeBindings = Object.keys(recipeBindingsByName).sort();
  const presetBindings = Object.keys(presetBindingsByName).sort();
  if (
    recipeBindings.length !== presetBindings.length ||
    recipeBindings.some((name, index) => name !== presetBindings[index])
  ) {
    throw new ServingCatalogValidationError(
      `Preset ${preset.metadata.id} bindings do not match recipe ${recipe.metadata.id}.`,
    );
  }
  for (const name of recipeBindings) {
    const expected = recipeBindingsByName[name]!;
    const actual = presetBindingsByName[name]!.valueFromTopologyQualification;
    const key = `${expected.qualificationId}@${String(expected.schemaVersion)}`;
    const descriptor = registries.topologyQualifications?.get(key);
    if (
      actual.id !== expected.qualificationId ||
      actual.schemaVersion !== expected.schemaVersion ||
      (descriptor &&
        (actual.output !== descriptor.bindingOutput ||
          expected.outputSchema !== descriptor.outputSchema))
    ) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} has invalid topology binding ${name}.`,
      );
    }
  }
}

function validateCatalogSemantics(
  recipes: readonly ServingRecipe[],
  presets: readonly ServingPreset[],
  registries: ServingCatalogRegistries,
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
    if (isLlamaCppServingRecipe(recipe)) {
      if (preset.spec.selection === "automatic") {
        throw new ServingCatalogValidationError(
          `Preset ${preset.metadata.id} must not use automatic selection for llama.cpp recipe ${recipe.metadata.id}; explicit-only and disabled presets are resolved outside automatic selection.`,
        );
      }
      if ((preset.spec.requirements?.all.length ?? 0) === 0) {
        throw new ServingCatalogValidationError(
          `Preset ${preset.metadata.id} must declare readiness requirements for llama.cpp recipe ${recipe.metadata.id}.`,
        );
      }
      validateLlamaCppPreset(recipe, preset, registries);
    }
    validateBindings(preset, recipe, registries);
    const nodeCount = (preset.spec.requirements?.all ?? []).find(
      (requirement) =>
        "fact" in requirement &&
        requirement.fact === "cluster.nodeCount" &&
        requirement.operator === "equals" &&
        typeof requirement.value === "number",
    );
    if (nodeCount && "fact" in nodeCount && recipe.spec.execution.nodeCount !== nodeCount.value) {
      throw new ServingCatalogValidationError(
        `Preset ${preset.metadata.id} node-count requirement does not match recipe ${recipe.metadata.id}.`,
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
  const sources: ServingCatalogSourceProvenance[] = [];
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
      validatePresetRequirements(preset, options.registries);
      presets.push(preset);
    }
    sources.push({ path: source.path, kind, id, digest: servingCatalogDigest(value) });
  }

  recipes.sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  presets.sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  validateCatalogSemantics(recipes, presets, options.registries);

  const payload: CompiledServingCatalogPayload = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    sourceRevision: options.sourceRevision,
    readinessSchemaRef: READINESS_SCHEMA_REF,
    recipes,
    presets,
    sources,
  };
  const catalog: CompiledServingCatalog = {
    ...payload,
    catalogDigest: servingCatalogDigest(payload),
  };
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
  const expectedDigest = servingCatalogDigest(catalogPayload(catalog));
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
