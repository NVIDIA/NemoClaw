// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { getBuildIdentity } from "../../core/version";
import { createHostReadinessReport } from "../../readiness/host";
import type { SystemReadinessReport } from "../../readiness/types";
import {
  isLlamaCppServingRecipe,
  LLAMA_CPP_HOST_LOCAL_LIFECYCLE_REF,
  LLAMA_CPP_HOST_LOCAL_MATERIALIZER_REF,
} from "../serving/adapter-registry";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import { resolveManagedInferenceServing } from "../serving/resolver";
import type {
  CompiledManagedInferenceCatalog,
  ResolvedLlamaCppInferenceSelection,
} from "../serving/types";
import { LLAMA_CPP_RECIPE_ENV } from "./contract";

export type ManagedLlamaCppSelectionResult =
  | { readonly kind: "selected"; readonly selection: ResolvedLlamaCppInferenceSelection }
  | { readonly kind: "rejected"; readonly reason: string };

function uniquePresetForRecipe(
  catalog: CompiledManagedInferenceCatalog,
  requestedRecipeId: string,
): string | null {
  const matches = catalog.presets.filter(
    (preset) =>
      preset.spec.selection === "explicit-only" &&
      preset.spec.plan.backend === "install-llama-cpp" &&
      preset.spec.plan.recipeRef === requestedRecipeId,
  );
  return matches.length === 1 ? matches[0]!.metadata.id : null;
}

function defaultRecipeId(catalog: CompiledManagedInferenceCatalog): string | null {
  const ids = new Set(
    catalog.presets
      .filter(
        (preset) =>
          preset.spec.selection === "explicit-only" &&
          preset.spec.plan.backend === "install-llama-cpp",
      )
      .map((preset) => preset.spec.plan.recipeRef),
  );
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Resolve one explicit managed llama.cpp recipe through fresh canonical host readiness. */
export function resolveManagedLlamaCppSelection(
  env: NodeJS.ProcessEnv = process.env,
  catalog: CompiledManagedInferenceCatalog = loadManagedInferenceCatalog(),
  report: SystemReadinessReport = createHostReadinessReport(getBuildIdentity()),
): ManagedLlamaCppSelectionResult {
  const requestedRecipeId = String(env[LLAMA_CPP_RECIPE_ENV] ?? "").trim();
  const recipeId = requestedRecipeId || defaultRecipeId(catalog);
  if (!recipeId) {
    return {
      kind: "rejected",
      reason: `${LLAMA_CPP_RECIPE_ENV} must name one supported declarative recipe.`,
    };
  }
  const presetId = uniquePresetForRecipe(catalog, recipeId);
  if (!presetId) {
    return {
      kind: "rejected",
      reason: `Managed llama.cpp recipe ${recipeId} does not resolve one explicit serving preset.`,
    };
  }
  if (String(env.NEMOCLAW_MODEL ?? "").trim()) {
    return {
      kind: "rejected",
      reason: `NEMOCLAW_MODEL cannot override the served model in ${LLAMA_CPP_RECIPE_ENV}.`,
    };
  }
  const resolution = resolveManagedInferenceServing(
    {
      readinessReports: [{ nodeId: os.hostname(), report }],
      topologyQualifications: [],
      intent: { provider: "install-llama-cpp", preset: presetId },
    },
    catalog,
  );
  if (resolution.outcome !== "selected") {
    return { kind: "rejected", reason: resolution.message };
  }
  if (
    !isLlamaCppServingRecipe(resolution.recipe) ||
    resolution.recipe.spec.execution.materializerRef !== LLAMA_CPP_HOST_LOCAL_MATERIALIZER_REF ||
    resolution.recipe.spec.execution.lifecycleRef !== LLAMA_CPP_HOST_LOCAL_LIFECYCLE_REF
  ) {
    return {
      kind: "rejected",
      reason: `Serving recipe ${recipeId} is not a managed llama.cpp recipe.`,
    };
  }
  return {
    kind: "selected",
    selection: {
      outcome: "selected",
      selection: resolution.selection,
      catalogDigest: resolution.catalogDigest,
      presetDigest: resolution.presetDigest,
      recipeDigest: resolution.recipeDigest,
      preset: resolution.preset,
      recipe: resolution.recipe,
    },
  };
}
