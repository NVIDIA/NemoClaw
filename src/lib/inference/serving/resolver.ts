// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { checkSystemReadinessSchemaVersion } from "../../readiness/compatibility.js";
import { getSystemReadinessReferenceErrors } from "../../readiness/references.js";
import type { SystemReadinessReport } from "../../readiness/types.js";
import { loadManagedInferenceCatalog } from "./catalog.js";
import { immutableManagedInferenceCopy } from "./catalog-integrity.js";
import {
  DUAL_SPARK_PRESET_ID,
  DUAL_SPARK_TOPOLOGY_QUALIFICATION_ID,
  DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
  type ManagedInferenceReadinessSource,
  type ManagedInferenceResolution,
  type ManagedInferenceResolverInput,
  type ManagedInferenceSelectionIntent,
  type ManagedInferenceServingPreset,
  type ManagedInferenceServingRecipe,
  type ManagedInferenceTopologyQualification,
} from "./catalog-types.js";
import { getDualSparkTopologyArtifactError } from "./dual-spark-topology.js";

export const MANAGED_INFERENCE_READINESS_MAX_AGE_MS = 30_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;
const SOURCE_REVISION = /^[0-9a-f]{40,64}$/u;
const PUBLIC_VERSION =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function explicitIntentWithoutPreset(intent: ManagedInferenceSelectionIntent): boolean {
  return (
    hasText(intent.provider) ||
    hasText(intent.vllmModel) ||
    (intent.vllmExtraArguments?.length ?? 0) > 0
  );
}

function readinessError(
  source: ManagedInferenceReadinessSource,
  nowMs: number,
  maxAgeMs: number,
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
  if (report.status !== "supported" || report.exitCode !== 0) {
    return `${nodeId}: readiness status is ${report.status}`;
  }
  if (report.findings.some(({ severity }) => severity === "fatal" || severity === "blocking")) {
    return `${nodeId}: readiness report contains a blocking finding`;
  }
  const sparkQualifications = report.qualifications.filter(
    ({ id }) => id === "host.platform.dgx_spark",
  );
  if (sparkQualifications.length !== 1 || sparkQualifications[0]?.status !== "qualified") {
    return `${nodeId}: DGX Spark qualification is not qualified`;
  }
  return undefined;
}

function readinessReportsError(
  sources: readonly ManagedInferenceReadinessSource[],
  nowMs: number,
  maxAgeMs: number,
): string | undefined {
  const nodeIds = sources.map(({ nodeId }) => nodeId);
  if (new Set(nodeIds).size !== nodeIds.length)
    return "readiness reports contain duplicate node IDs";
  for (const source of sources) {
    const error = readinessError(source, nowMs, maxAgeMs);
    if (error) return error;
  }
  return undefined;
}

function requirementsError<TOutput>(
  preset: ManagedInferenceServingPreset,
  reports: readonly ManagedInferenceReadinessSource[],
  topology: ManagedInferenceTopologyQualification<TOutput>,
): string | undefined {
  for (const requirement of preset.spec.requirements.all) {
    if ("readiness" in requirement) {
      const matches = reports.every(({ report }) =>
        report.qualifications.some(
          ({ id, status }) =>
            id === requirement.readiness.id && status === requirement.readiness.status,
        ),
      );
      if (!matches) return `readiness requirement ${requirement.readiness.id} did not match`;
    } else if ("fact" in requirement) {
      if (
        requirement.state !== "present" ||
        requirement.operator !== "equals" ||
        reports.length !== requirement.value
      ) {
        return `selection fact ${requirement.fact} did not match`;
      }
    } else if (
      topology.id !== requirement.topologyQualification.id ||
      topology.schemaVersion !== requirement.topologyQualification.schemaVersion ||
      topology.status !== requirement.topologyQualification.status
    ) {
      return `topology requirement ${requirement.topologyQualification.id} did not match`;
    }
  }
  return undefined;
}

function intentCompatibilityError(
  intent: ManagedInferenceSelectionIntent,
  recipe: ManagedInferenceServingRecipe,
): string | undefined {
  if (hasText(intent.provider) && intent.provider !== recipe.spec.backend) {
    return `provider ${intent.provider} conflicts with preset ${DUAL_SPARK_PRESET_ID}`;
  }
  if (
    hasText(intent.vllmModel) &&
    intent.vllmModel !== recipe.spec.model.id &&
    intent.vllmModel !== recipe.spec.model.servedName
  ) {
    return `model ${intent.vllmModel} conflicts with preset ${DUAL_SPARK_PRESET_ID}`;
  }
  if ((intent.vllmExtraArguments?.length ?? 0) > 0) {
    return `extra vLLM arguments conflict with preset ${DUAL_SPARK_PRESET_ID}`;
  }
  return undefined;
}

function rejectOrSkip(explicit: boolean, message: string): ManagedInferenceResolution<never> {
  return explicit
    ? { outcome: "rejected", code: "requirements-not-met", message }
    : { outcome: "no-match", code: "requirements-not-met", message };
}

export function resolveManagedInferenceServing<TTopologyOutput>(
  input: ManagedInferenceResolverInput<TTopologyOutput>,
): ManagedInferenceResolution<TTopologyOutput> {
  const catalog = loadManagedInferenceCatalog();
  const intent = input.intent ?? {};
  const explicitPreset = hasText(intent.preset) ? intent.preset : undefined;
  if (!explicitPreset && explicitIntentWithoutPreset(intent)) {
    return {
      outcome: "no-match",
      code: "explicit-intent",
      message: "Existing inference intent remains authoritative.",
    };
  }
  if (explicitPreset && explicitPreset !== DUAL_SPARK_PRESET_ID) {
    return {
      outcome: "rejected",
      code: "unknown-preset",
      message: `Unknown managed inference preset ${explicitPreset}.`,
    };
  }

  const explicit = explicitPreset !== undefined;
  const preset = catalog.presets[0]?.definition;
  const recipe = catalog.recipes[0]?.definition;
  if (!preset || !recipe) throw new Error("compiled managed inference catalog is incomplete");
  const intentError = intentCompatibilityError(intent, recipe);
  if (intentError)
    return { outcome: "rejected", code: "incompatible-intent", message: intentError };
  if (input.readinessReports.length !== recipe.spec.execution.nodeCount) {
    return rejectOrSkip(explicit, "The preset requires exactly two readiness reports.");
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
  const reportsError = readinessReportsError(input.readinessReports, nowMs, maxAgeMs);
  if (reportsError) {
    return { outcome: "rejected", code: "invalid-readiness", message: reportsError };
  }

  const matchingTopologies = input.topologyQualifications.filter(
    ({ id, schemaVersion }) =>
      id === DUAL_SPARK_TOPOLOGY_QUALIFICATION_ID &&
      schemaVersion === DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
  );
  if (matchingTopologies.length === 0) {
    return rejectOrSkip(explicit, "The qualified two-Spark topology is unavailable.");
  }
  if (matchingTopologies.length !== 1) {
    return {
      outcome: "rejected",
      code: "invalid-topology",
      message: "Topology qualifications contain more than one candidate for the same subject.",
    };
  }
  let topology: ManagedInferenceTopologyQualification<unknown>;
  try {
    topology = immutableManagedInferenceCopy(matchingTopologies[0]!);
  } catch {
    return {
      outcome: "rejected",
      code: "invalid-topology",
      message: "Topology qualification is not immutable JSON data.",
    };
  }
  const expectedNodeIds = input.readinessReports.map(({ nodeId }) => nodeId).sort();
  const invalidTopology = getDualSparkTopologyArtifactError(topology, expectedNodeIds);
  if (invalidTopology) {
    return { outcome: "rejected", code: "invalid-topology", message: invalidTopology };
  }
  const unmetRequirement = requirementsError(preset, input.readinessReports, topology);
  if (unmetRequirement) return rejectOrSkip(explicit, unmetRequirement);

  return {
    outcome: "selected",
    selection: explicit ? "explicit" : "automatic",
    catalogDigest: catalog.catalogDigest,
    preset,
    recipe,
    topologyQualification: topology as ManagedInferenceTopologyQualification<TTopologyOutput>,
  };
}
