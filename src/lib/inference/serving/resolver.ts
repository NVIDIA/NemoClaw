// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { checkSystemReadinessSchemaVersion } from "../../readiness/compatibility.js";
import {
  evaluateOnboardReadinessAdmission,
  ONBOARD_READINESS_FINDING_IDS,
} from "../../readiness/onboard-admission.js";
import { getSystemReadinessReferenceErrors } from "../../readiness/references.js";
import {
  hasRemediableStorageConflict,
  STORAGE_COMPATIBLE_CAPABILITY,
} from "../../readiness/storage-remediation.js";
import type { SystemReadinessReport } from "../../readiness/types.js";
import {
  getManagedInferenceMaterializerDescriptor,
  getManagedInferenceRecipeRegistrationError,
  getManagedInferenceTopologyQualificationDescriptor,
  isHostLocalInferenceServingRecipe,
  isLlamaCppServingRecipe,
  isManagedClusterInferenceServingRecipe,
} from "./adapter-registry.js";
import { immutableManagedInferenceCopy, managedInferenceDigest } from "./catalog-integrity.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
import type {
  CompiledManagedInferenceCatalog,
  ManagedInferenceFactRequirement,
  ManagedInferencePresetRequirement,
  ManagedInferenceReadinessRequirement,
  ManagedInferenceReadinessSource,
  ManagedInferenceResolution,
  ManagedInferenceResolverInput,
  ManagedInferenceRuntimeServingRecipe,
  ManagedInferenceSelectionIntent,
  ManagedInferenceServingPreset,
  ManagedInferenceServingRecipe,
  ManagedInferenceTopologyQualification,
  ManagedInferenceTopologyRequirement,
  ResolvedHostLocalInferenceSelection,
  ResolvedManagedInferenceSelection,
  ServingReadinessComparison,
} from "./types.js";

export const MANAGED_INFERENCE_READINESS_MAX_AGE_MS = 30_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;
const SOURCE_REVISION = /^[0-9a-f]{40,64}$/u;
const PUBLIC_VERSION =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

type SelectionOperator = ManagedInferenceFactRequirement["operator"];

type RequirementEvaluation<TOutput> =
  | {
      readonly outcome: "matched";
      readonly topologyQualifications: readonly ManagedInferenceTopologyQualification<TOutput>[];
    }
  | { readonly outcome: "unmet"; readonly message: string }
  | { readonly outcome: "invalid-topology"; readonly message: string };

interface MatchingCandidate<TOutput> {
  readonly preset: ManagedInferenceServingPreset;
  readonly presetDigest: string;
  readonly recipe: ManagedInferenceRuntimeServingRecipe;
  readonly recipeDigest: string;
  readonly priority: number;
  readonly topologyQualification?: ManagedInferenceTopologyQualification<TOutput>;
}

interface RuntimeRequirementFailure {
  readonly outcome: "runtime-unmet";
  readonly message: string;
  readonly presetId: string;
  readonly priority: number;
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unmanagedExplicitIntent(intent: ManagedInferenceSelectionIntent): boolean {
  return intent.vllmExtraArguments?.some(hasText) ?? false;
}

function recipeMatchesModelIntent(
  recipe: ManagedInferenceRuntimeServingRecipe,
  model: string,
): boolean {
  const normalizedModel = model.toLowerCase();
  return (
    normalizedModel === recipe.spec.model.id.toLowerCase() ||
    normalizedModel === recipe.spec.model.servedName.toLowerCase() ||
    ("environmentValue" in recipe.spec.model &&
      normalizedModel === recipe.spec.model.environmentValue.toLowerCase())
  );
}

function hasManagedVllmIntent(
  intent: ManagedInferenceSelectionIntent,
  catalog: CompiledManagedInferenceCatalog,
): boolean {
  if (intent.provider === "vllm" || hasText(intent.vllmModel)) return true;
  if (!hasText(intent.preset)) return false;
  const presets = catalog.presets.filter(({ metadata }) => metadata.id === intent.preset);
  return presets.length === 1 && presets[0]!.spec.plan.backend === "vllm";
}

function hasRemediableStorageFinding(report: SystemReadinessReport): boolean {
  const storageFindings = report.findings.filter(
    ({ id, severity }) =>
      id === ONBOARD_READINESS_FINDING_IDS.storageIncompatible && severity === "blocking",
  );
  return (
    storageFindings.length === 1 &&
    hasRemediableStorageConflict({ ...report, findings: storageFindings })
  );
}

function hasAdmittedReadinessException(
  report: SystemReadinessReport,
  allowDeferredN1xManagedVllm: boolean,
): boolean {
  if (report.status !== "incompatible" || report.exitCode !== 2) return false;
  const remediableStorage = hasRemediableStorageFinding(report);
  const admission = evaluateOnboardReadinessAdmission(report, {
    explicitlyOptedOutGpuPassthrough: false,
    allowUnsupportedRuntime: false,
    allowStorageRemediation: remediableStorage,
    allowDeferredN1xManagedVllm,
  });
  if (!admission.admitted || admission.waivedFindingIds.length === 0) return false;
  const waivedFindingIds = new Set(admission.waivedFindingIds);
  if (waivedFindingIds.size !== admission.waivedFindingIds.length) return false;
  const allowedFindingIds = new Set<string>([
    ONBOARD_READINESS_FINDING_IDS.storageIncompatible,
    ...(allowDeferredN1xManagedVllm
      ? [ONBOARD_READINESS_FINDING_IDS.n1xValidationPending]
      : []),
  ]);
  return admission.waivedFindingIds.every((id) => allowedFindingIds.has(id));
}

function readinessError(
  source: ManagedInferenceReadinessSource,
  nowMs: number,
  maxAgeMs: number,
  allowDeferredN1xManagedVllm: boolean,
): string | undefined {
  const { nodeId, report } = source;
  if (!hasText(nodeId)) return "readiness node ID is empty";
  const compatibility = checkSystemReadinessSchemaVersion(report.schemaVersion);
  if (!compatibility.compatible) return `${nodeId}: ${compatibility.reason}`;
  if (report.mutated !== false) return `${nodeId}: readiness report is not read-only`;
  if (!PUBLIC_VERSION.test(report.provenance.nemoclawVersion)) {
    return `${nodeId}: readiness producer version is invalid`;
  }
  if (!SOURCE_REVISION.test(report.provenance.sourceRevision)) {
    return `${nodeId}: readiness source revision is invalid`;
  }
  const observedAt = Date.parse(report.provenance.observedAt);
  const ageMs = nowMs - observedAt;
  if (!Number.isFinite(observedAt) || ageMs > maxAgeMs || ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
    return `${nodeId}: readiness report is stale or has an invalid observation time`;
  }
  const referenceErrors = getSystemReadinessReferenceErrors(report);
  if (referenceErrors.length > 0) return `${nodeId}: ${referenceErrors[0]}`;
  const admittedReadinessException = hasAdmittedReadinessException(
    report,
    allowDeferredN1xManagedVllm,
  );
  if ((report.status !== "supported" || report.exitCode !== 0) && !admittedReadinessException) {
    return `${nodeId}: readiness status is ${report.status}`;
  }
  if (
    report.findings.some(({ severity }) => severity === "fatal" || severity === "blocking") &&
    !admittedReadinessException
  ) {
    return `${nodeId}: readiness report contains a blocking finding`;
  }
  return undefined;
}

function readinessReportsError(
  sources: readonly ManagedInferenceReadinessSource[],
  nowMs: number,
  maxAgeMs: number,
  allowDeferredN1xManagedVllm: boolean,
): string | undefined {
  const nodeIds = sources.map(({ nodeId }) => nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) {
    return "readiness reports contain duplicate node IDs";
  }
  for (const source of sources) {
    const error = readinessError(source, nowMs, maxAgeMs, allowDeferredN1xManagedVllm);
    if (error) return error;
  }
  return undefined;
}

function scalarEquals(actual: unknown, expected: unknown): boolean {
  return (
    (actual === null || ["string", "number", "boolean"].includes(typeof actual)) &&
    actual === expected
  );
}

function matchesOperator(actual: unknown, operator: SelectionOperator, expected: unknown): boolean {
  switch (operator) {
    case "equals":
      return scalarEquals(actual, expected);
    case "oneOf":
      return (
        Array.isArray(expected) && expected.some((candidate) => scalarEquals(actual, candidate))
      );
    case "atLeast":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "atMost":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "between":
      return (
        typeof actual === "number" &&
        Array.isArray(expected) &&
        expected.length === 2 &&
        typeof expected[0] === "number" &&
        typeof expected[1] === "number" &&
        actual >= expected[0] &&
        actual <= expected[1]
      );
  }
}

function readinessScopeMatches(
  scope: string,
  reports: readonly ManagedInferenceReadinessSource[],
  predicate: (source: ManagedInferenceReadinessSource) => boolean,
): boolean {
  if (reports.length === 0) return false;
  if (scope === "everyNode") return reports.every(predicate);
  if (scope === "anyNode") return reports.some(predicate);
  return false;
}

function compareNumericDottedVersions(left: string, right: string): number | undefined {
  const parse = (value: string): number[] | undefined => {
    if (!/^\d+(?:\.\d+)*$/u.test(value)) return undefined;
    const parts = value.split(".").map(Number);
    return parts.every(Number.isSafeInteger) ? parts : undefined;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return undefined;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function readinessComparisonMatches(
  actual: unknown,
  comparison: ServingReadinessComparison,
): boolean {
  switch (comparison.operator) {
    case "equals":
      return scalarEquals(actual, comparison.value);
    case "one-of":
      return comparison.values.some((candidate) => scalarEquals(actual, candidate));
    case "at-least":
      return typeof actual === "number" && actual >= comparison.value;
    case "version-at-least": {
      if (typeof actual !== "string") return false;
      const order = compareNumericDottedVersions(actual, comparison.value);
      return order !== undefined && order >= 0;
    }
  }
}

function readinessRequirementMatches(
  requirement: ManagedInferenceReadinessRequirement["readiness"],
  reports: readonly ManagedInferenceReadinessSource[],
): boolean {
  return readinessScopeMatches(requirement.scope, reports, ({ report }) => {
    if (requirement.kind === "qualification") {
      const matches = report.qualifications.filter(({ id }) => id === requirement.id);
      return matches.length === 1 && matches[0]!.status === requirement.status;
    }
    if ("comparison" in requirement) {
      const matches = report.observations.filter(({ id }) => id === requirement.id);
      return (
        matches.length === 1 &&
        matches[0]!.state === "present" &&
        readinessComparisonMatches(matches[0]!.value, requirement.comparison)
      );
    }
    const collection =
      requirement.kind === "observation" ? report.observations : report.capabilities;
    const matches = collection.filter(({ id }) => id === requirement.id);
    if (matches.length === 1 && matches[0]!.state === requirement.state) return true;
    return (
      requirement.kind === "capability" &&
      requirement.id === STORAGE_COMPATIBLE_CAPABILITY &&
      requirement.state === "present" &&
      hasRemediableStorageFinding(report)
    );
  });
}

function selectionFact(
  path: string,
  reports: readonly ManagedInferenceReadinessSource[],
):
  | {
      readonly state: "present";
      readonly value: ManagedInferenceFactRequirement["value"];
    }
  | undefined {
  if (path === "cluster.nodeCount") return { state: "present", value: reports.length };
  return undefined;
}

function factRequirementMatches(
  requirement: ManagedInferenceFactRequirement,
  reports: readonly ManagedInferenceReadinessSource[],
): boolean {
  const fact = selectionFact(requirement.fact, reports);
  if (!fact) return false;
  return (
    requirement.state === fact.state &&
    matchesOperator(fact.value, requirement.operator, requirement.value)
  );
}

function evaluateTopologyRequirement<TOutput>(
  requirement: ManagedInferenceTopologyRequirement["topologyQualification"],
  artifacts: readonly ManagedInferenceTopologyQualification<TOutput>[],
  expectedSubjectNodeIds: readonly string[],
):
  | {
      readonly outcome: "matched";
      readonly artifact: ManagedInferenceTopologyQualification<TOutput>;
    }
  | { readonly outcome: "unmet"; readonly message: string }
  | { readonly outcome: "invalid-topology"; readonly message: string } {
  const descriptor = getManagedInferenceTopologyQualificationDescriptor(
    requirement.id,
    requirement.schemaVersion,
  );
  if (!descriptor) {
    return {
      outcome: "invalid-topology",
      message: `Topology qualification ${requirement.id}@${String(requirement.schemaVersion)} is not registered.`,
    };
  }
  const matching = artifacts.filter(
    ({ id, schemaVersion }) => id === requirement.id && schemaVersion === requirement.schemaVersion,
  );
  if (matching.length === 0) {
    return {
      outcome: "unmet",
      message: `Topology requirement ${requirement.id} did not match.`,
    };
  }
  if (matching.length !== 1) {
    return {
      outcome: "invalid-topology",
      message: `Topology qualification ${requirement.id} has more than one candidate.`,
    };
  }
  const artifact = matching[0]!;
  if (artifact.status !== requirement.status) {
    return {
      outcome: "unmet",
      message: `Topology requirement ${requirement.id} did not match.`,
    };
  }
  const error = descriptor.validateArtifact(artifact, expectedSubjectNodeIds);
  return error ? { outcome: "invalid-topology", message: error } : { outcome: "matched", artifact };
}

function evaluateRequirements<TOutput>(
  preset: ManagedInferenceServingPreset,
  reports: readonly ManagedInferenceReadinessSource[],
  topologyQualifications: readonly ManagedInferenceTopologyQualification<TOutput>[],
): RequirementEvaluation<TOutput> {
  const matchedTopologies: ManagedInferenceTopologyQualification<TOutput>[] = [];
  const expectedSubjectNodeIds = reports.map(({ nodeId }) => nodeId).sort(compareStrings);
  for (const requirement of preset.spec.requirements.all) {
    if ("readiness" in requirement) {
      if (!readinessRequirementMatches(requirement.readiness, reports)) {
        return {
          outcome: "unmet",
          message: `Readiness requirement ${requirement.readiness.id} did not match.`,
        };
      }
      continue;
    }
    if ("fact" in requirement) {
      if (!factRequirementMatches(requirement, reports)) {
        return {
          outcome: "unmet",
          message: `Selection fact ${requirement.fact} did not match.`,
        };
      }
      continue;
    }
    const topology = evaluateTopologyRequirement(
      requirement.topologyQualification,
      topologyQualifications,
      expectedSubjectNodeIds,
    );
    if (topology.outcome !== "matched") return topology;
    matchedTopologies.push(topology.artifact);
  }
  return { outcome: "matched", topologyQualifications: matchedTopologies };
}

function runtimeMemoryRequirementError(
  recipe: ManagedInferenceRuntimeServingRecipe,
  reports: readonly ManagedInferenceReadinessSource[],
): string | undefined {
  const minimum =
    recipe.spec.runtime && "minimumGpuMemoryBytes" in recipe.spec.runtime
      ? recipe.spec.runtime.minimumGpuMemoryBytes
      : undefined;
  if (minimum === undefined) return undefined;
  for (const { nodeId, report } of reports) {
    const observationValue = (id: string): unknown => {
      const matches = report.observations.filter((observation) => observation.id === id);
      return matches.length === 1 && matches[0]!.state === "present"
        ? matches[0]!.value
        : undefined;
    };
    const unified = observationValue("host.gpu.unified_memory") === true;
    const available = observationValue(
      unified ? "host.gpu.memory_total_bytes" : "host.gpu.memory_per_device_bytes",
    );
    if (typeof available !== "number") {
      return `${nodeId}: GPU memory capacity could not be determined.`;
    }
    if (available < minimum) {
      return `${nodeId}: GPU memory capacity ${String(available)} is below the recipe minimum ${String(minimum)} bytes.`;
    }
  }
  return undefined;
}

function intentCompatibilityError(
  intent: ManagedInferenceSelectionIntent,
  preset: ManagedInferenceServingPreset,
  recipe: ManagedInferenceRuntimeServingRecipe,
): string | undefined {
  if (hasText(intent.provider) && intent.provider !== recipe.spec.backend) {
    return `provider ${intent.provider} conflicts with preset ${preset.metadata.id}`;
  }
  if (
    hasText(intent.vllmModel) &&
    !recipeMatchesModelIntent(recipe, intent.vllmModel)
  ) {
    return `model ${intent.vllmModel} conflicts with preset ${preset.metadata.id}`;
  }
  if (unmanagedExplicitIntent(intent)) {
    return `extra vLLM arguments conflict with preset ${preset.metadata.id}`;
  }
  return undefined;
}

function presetPriority(preset: ManagedInferenceServingPreset): number {
  const priority = (preset.spec as { readonly priority?: unknown }).priority;
  if (!Number.isSafeInteger(priority)) {
    throw new Error(`managed inference preset ${preset.metadata.id} has an invalid priority`);
  }
  return priority as number;
}

function recipeForPreset(
  catalog: CompiledManagedInferenceCatalog,
  preset: ManagedInferenceServingPreset,
): CompiledManagedInferenceCatalog["recipes"][number] {
  const matches = catalog.recipes.filter(
    ({ metadata }) => metadata.id === preset.spec.plan.recipeRef,
  );
  if (matches.length !== 1) {
    throw new Error(
      `managed inference preset ${preset.metadata.id} does not resolve exactly one recipe ${preset.spec.plan.recipeRef}`,
    );
  }
  const compiledRecipe = matches[0]!;
  const recipe = compiledRecipe;
  if (recipe.spec.backend !== preset.spec.plan.backend) {
    throw new Error(
      `managed inference preset ${preset.metadata.id} backend does not match its recipe`,
    );
  }
  const registrationError = getManagedInferenceRecipeRegistrationError(recipe);
  if (registrationError) {
    throw new Error(`managed inference recipe ${recipe.metadata.id}: ${registrationError}`);
  }
  return compiledRecipe;
}

function matchingCandidate<TOutput>(
  catalog: CompiledManagedInferenceCatalog,
  compiledPreset: CompiledManagedInferenceCatalog["presets"][number],
  input: ManagedInferenceResolverInput<TOutput>,
):
  | {
      readonly outcome: "matched";
      readonly candidate: MatchingCandidate<TOutput>;
    }
  | RuntimeRequirementFailure
  | { readonly outcome: "unmet"; readonly message: string }
  | { readonly outcome: "invalid-topology"; readonly message: string }
  | { readonly outcome: "incompatible-intent"; readonly message: string } {
  const preset = compiledPreset;
  const compiledRecipe = recipeForPreset(catalog, preset);
  const recipe = compiledRecipe;
  const intentError = intentCompatibilityError(input.intent ?? {}, preset, recipe);
  if (intentError) return { outcome: "incompatible-intent", message: intentError };
  const requirements = evaluateRequirements(
    preset,
    input.readinessReports,
    input.topologyQualifications,
  );
  if (requirements.outcome !== "matched") return requirements;
  const memoryError = runtimeMemoryRequirementError(recipe, input.readinessReports);
  if (memoryError) {
    return {
      outcome: "runtime-unmet",
      message: memoryError,
      presetId: preset.metadata.id,
      priority: presetPriority(preset),
    };
  }
  const materializer = getManagedInferenceMaterializerDescriptor(
    recipe.spec.execution.materializerRef,
  );
  const expectedTopologyCount = materializer?.topology ? 1 : 0;
  if (requirements.topologyQualifications.length !== expectedTopologyCount) {
    return {
      outcome: "invalid-topology",
      message: `Preset ${preset.metadata.id} must resolve exactly ${String(expectedTopologyCount)} topology qualification${expectedTopologyCount === 1 ? "" : "s"}.`,
    };
  }
  return {
    outcome: "matched",
    candidate: {
      preset,
      presetDigest: managedInferenceDigest(compiledPreset),
      recipe,
      recipeDigest: managedInferenceDigest(compiledRecipe),
      priority: presetPriority(preset),
      ...(requirements.topologyQualifications[0]
        ? { topologyQualification: requirements.topologyQualifications[0] }
        : {}),
    },
  };
}

function selectedResolution<TOutput>(
  catalog: CompiledManagedInferenceCatalog,
  candidate: MatchingCandidate<TOutput>,
  selection: "automatic" | "explicit",
): ManagedInferenceResolution<TOutput> {
  let topologyQualification: ManagedInferenceTopologyQualification<TOutput> | undefined;
  if (candidate.topologyQualification) {
    try {
      topologyQualification = immutableManagedInferenceCopy(candidate.topologyQualification);
    } catch {
      return {
        outcome: "rejected",
        code: "invalid-topology",
        message: "Topology qualification is not immutable JSON data.",
      };
    }
  }
  const common = {
    outcome: "selected",
    selection,
    catalogDigest: catalog.catalogDigest,
    presetDigest: candidate.presetDigest,
    recipeDigest: candidate.recipeDigest,
    preset: candidate.preset,
    recipe: candidate.recipe,
  } as const;
  if (topologyQualification && isManagedClusterInferenceServingRecipe(common.recipe)) {
    return { ...common, recipe: common.recipe, topologyQualification };
  }
  if (isHostLocalInferenceServingRecipe(common.recipe)) {
    return { ...common, recipe: common.recipe };
  }
  if (isLlamaCppServingRecipe(common.recipe)) {
    return { ...common, recipe: common.recipe };
  }
  return {
    outcome: "rejected",
    code: "invalid-topology",
    message: `Preset ${common.preset.metadata.id} selected a topology-dependent recipe without a topology qualification.`,
  };
}

export function resolveManagedInferenceServing<TOutput>(
  input: ManagedInferenceResolverInput<TOutput>,
  catalog: CompiledManagedInferenceCatalog = loadManagedInferenceCatalog(),
): ManagedInferenceResolution<TOutput> {
  const intent = input.intent ?? {};
  const explicitPresetId = hasText(intent.preset) ? intent.preset : undefined;
  const explicitModel = hasText(intent.vllmModel) ? intent.vllmModel : undefined;
  if (!explicitPresetId && unmanagedExplicitIntent(intent)) {
    return {
      outcome: "no-match",
      code: "explicit-intent",
      message: "Existing inference intent remains authoritative.",
    };
  }

  const maxAgeMs = input.maxReadinessAgeMs ?? MANAGED_INFERENCE_READINESS_MAX_AGE_MS;
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(nowMs)) {
    return {
      outcome: "rejected",
      code: "invalid-readiness",
      message: "Readiness freshness policy is invalid.",
    };
  }
  const reportsError = readinessReportsError(
    input.readinessReports,
    nowMs,
    maxAgeMs,
    hasManagedVllmIntent(intent, catalog),
  );
  if (reportsError) {
    return {
      outcome: "rejected",
      code: "invalid-readiness",
      message: reportsError,
    };
  }

  if (explicitPresetId) {
    const matches = catalog.presets.filter(({ metadata }) => metadata.id === explicitPresetId);
    if (matches.length !== 1) {
      return {
        outcome: "rejected",
        code: "unknown-preset",
        message: `Unknown managed inference preset ${explicitPresetId}.`,
      };
    }
    const compiledPreset = matches[0]!;
    const preset = compiledPreset;
    if (preset.spec.selection === "disabled") {
      return {
        outcome: "rejected",
        code: "requirements-not-met",
        message: `Managed inference preset ${explicitPresetId} is disabled.`,
      };
    }
    const evaluated = matchingCandidate(catalog, compiledPreset, input);
    if (evaluated.outcome === "matched") {
      return selectedResolution(catalog, evaluated.candidate, "explicit");
    }
    return {
      outcome: "rejected",
      code:
        evaluated.outcome === "invalid-topology"
          ? "invalid-topology"
          : evaluated.outcome === "incompatible-intent"
            ? "incompatible-intent"
            : "requirements-not-met",
      message: evaluated.message,
    };
  }

  if (explicitModel) {
    const modelPresets = catalog.presets.filter((preset) => {
      if (preset.spec.selection === "disabled") return false;
      return recipeMatchesModelIntent(recipeForPreset(catalog, preset), explicitModel);
    });
    if (modelPresets.length === 0) {
      return {
        outcome: "rejected",
        code: "requirements-not-met",
        message: `No managed vLLM profile defines model ${explicitModel}.`,
      };
    }

    const matching: MatchingCandidate<TOutput>[] = [];
    let firstFailure: Exclude<
      ReturnType<typeof matchingCandidate<TOutput>>,
      { readonly outcome: "matched" }
    > | undefined;
    for (const compiledPreset of modelPresets) {
      const evaluated = matchingCandidate(catalog, compiledPreset, input);
      if (evaluated.outcome === "matched") matching.push(evaluated.candidate);
      else firstFailure ??= evaluated;
    }
    if (matching.length === 0) {
      return {
        outcome: "rejected",
        code: firstFailure?.outcome === "invalid-topology" ? "invalid-topology" : "requirements-not-met",
        message:
          firstFailure?.message ?? `No compatible managed vLLM profile defines model ${explicitModel}.`,
      };
    }
    matching.sort(
      (left, right) =>
        right.priority - left.priority ||
        compareStrings(left.preset.metadata.id, right.preset.metadata.id),
    );
    const highestPriority = matching[0]!.priority;
    const tied = matching.filter(({ priority }) => priority === highestPriority);
    if (tied.length !== 1) {
      return {
        outcome: "rejected",
        code: "ambiguous-selection",
        message: `Managed vLLM model ${explicitModel} is ambiguous at priority ${String(
          highestPriority,
        )}: ${tied.map(({ preset }) => preset.metadata.id).join(", ")}.`,
      };
    }
    return selectedResolution(catalog, tied[0]!, "explicit");
  }

  const matching: MatchingCandidate<TOutput>[] = [];
  let runtimeFailure: RuntimeRequirementFailure | undefined;
  let firstInvalidTopology: string | undefined;
  for (const compiledPreset of catalog.presets) {
    const preset = compiledPreset;
    if (preset.spec.selection !== "automatic") continue;
    const evaluated = matchingCandidate(catalog, compiledPreset, input);
    if (evaluated.outcome === "matched") matching.push(evaluated.candidate);
    else if (
      evaluated.outcome === "runtime-unmet" &&
      (!runtimeFailure ||
        evaluated.priority > runtimeFailure.priority ||
        (evaluated.priority === runtimeFailure.priority &&
          compareStrings(evaluated.presetId, runtimeFailure.presetId) < 0))
    ) {
      runtimeFailure = evaluated;
    }
    else if (evaluated.outcome === "invalid-topology") firstInvalidTopology ??= evaluated.message;
  }
  if (firstInvalidTopology) {
    return {
      outcome: "rejected",
      code: "invalid-topology",
      message: firstInvalidTopology,
    };
  }
  if (matching.length === 0) {
    return {
      outcome: "no-match",
      code: "requirements-not-met",
      message: runtimeFailure?.message ?? "No automatic managed inference preset matched.",
    };
  }
  matching.sort(
    (left, right) =>
      right.priority - left.priority ||
      compareStrings(left.preset.metadata.id, right.preset.metadata.id),
  );
  const highestPriority = matching[0]!.priority;
  const tied = matching.filter(({ priority }) => priority === highestPriority);
  if (tied.length !== 1) {
    return {
      outcome: "rejected",
      code: "ambiguous-selection",
      message: `Automatic managed inference selection is ambiguous at priority ${String(
        highestPriority,
      )}: ${tied.map(({ preset }) => preset.metadata.id).join(", ")}.`,
    };
  }
  return selectedResolution(catalog, tied[0]!, "automatic");
}
