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

export interface ManagedLlamaCppSelectionChoice {
  readonly priority: number;
  readonly selection: ResolvedLlamaCppInferenceSelection;
}

function selectablePresetsForRecipe(
  catalog: CompiledManagedInferenceCatalog,
  requestedRecipeId: string,
): readonly string[] {
  return catalog.presets
    .filter(
      (preset) =>
        preset.spec.selection !== "disabled" &&
        preset.spec.plan.backend === "install-llama-cpp" &&
        preset.spec.plan.recipeRef === requestedRecipeId,
    )
    .map(({ metadata }) => metadata.id)
    .sort((left, right) => left.localeCompare(right));
}

function validatedLlamaCppSelection(
  resolution: ReturnType<typeof resolveManagedInferenceServing>,
  recipeId: string,
): ManagedLlamaCppSelectionResult {
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

/** List one compatible automatic profile per managed llama.cpp recipe. */
export function listManagedLlamaCppSelectionChoices(
  catalog: CompiledManagedInferenceCatalog = loadManagedInferenceCatalog(),
  report: SystemReadinessReport = createHostReadinessReport(getBuildIdentity()),
): readonly ManagedLlamaCppSelectionChoice[] {
  const choices = catalog.presets
    .filter(
      ({ spec }) => spec.selection === "automatic" && spec.plan.backend === "install-llama-cpp",
    )
    .flatMap((preset) => {
      const resolution = resolveManagedInferenceServing(
        {
          readinessReports: [{ nodeId: os.hostname(), report }],
          topologyQualifications: [],
          intent: { provider: "install-llama-cpp", preset: preset.metadata.id },
        },
        catalog,
      );
      if (resolution.outcome !== "selected") {
        if (resolution.code === "invalid-readiness" || resolution.code === "invalid-topology") {
          throw new Error(resolution.message);
        }
        return [];
      }
      const validated = validatedLlamaCppSelection(resolution, preset.spec.plan.recipeRef);
      if (validated.kind === "rejected") throw new Error(validated.reason);
      return [{ priority: preset.spec.priority, selection: validated.selection }];
    })
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.selection.preset.metadata.id.localeCompare(right.selection.preset.metadata.id),
    );

  const byRecipe = new Map<string, ManagedLlamaCppSelectionChoice>();
  for (const choice of choices) {
    const recipeId = choice.selection.recipe.metadata.id;
    const previous = byRecipe.get(recipeId);
    if (previous?.priority === choice.priority) {
      throw new Error(
        `Managed llama.cpp recipe ${recipeId} matches more than one automatic serving preset at priority ${String(choice.priority)}.`,
      );
    }
    if (!previous) byRecipe.set(recipeId, choice);
  }
  return Object.freeze([...byRecipe.values()]);
}

/** Resolve one managed llama.cpp recipe through fresh canonical host readiness. */
export function resolveManagedLlamaCppSelection(
  env: NodeJS.ProcessEnv = process.env,
  catalog: CompiledManagedInferenceCatalog = loadManagedInferenceCatalog(),
  report: SystemReadinessReport = createHostReadinessReport(getBuildIdentity()),
): ManagedLlamaCppSelectionResult {
  const requestedRecipeId = String(env[LLAMA_CPP_RECIPE_ENV] ?? "").trim();
  if (String(env.NEMOCLAW_MODEL ?? "").trim()) {
    return {
      kind: "rejected",
      reason: `NEMOCLAW_MODEL cannot override the served model in ${LLAMA_CPP_RECIPE_ENV}.`,
    };
  }
  if (!requestedRecipeId) {
    let choices: readonly ManagedLlamaCppSelectionChoice[];
    try {
      choices = listManagedLlamaCppSelectionChoices(catalog, report);
    } catch (error) {
      return {
        kind: "rejected",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (choices.length === 0) {
      return {
        kind: "rejected",
        reason: "No automatic managed llama.cpp preset matches this host.",
      };
    }
    const highestPriority = choices[0]!.priority;
    const highestPriorityChoices = choices.filter(({ priority }) => priority === highestPriority);
    if (highestPriorityChoices.length > 1) {
      return {
        kind: "rejected",
        reason: `Automatic managed llama.cpp selection is ambiguous at priority ${String(highestPriority)}: ${highestPriorityChoices
          .map(({ selection }) => selection.preset.metadata.id)
          .join(", ")}.`,
      };
    }
    const selection = highestPriorityChoices[0]!.selection;
    return {
      kind: "selected",
      selection: { ...selection, selection: "automatic" },
    };
  }

  const recipeId = requestedRecipeId;
  const presetIds = selectablePresetsForRecipe(catalog, recipeId);
  if (presetIds.length === 0) {
    return {
      kind: "rejected",
      reason: `Managed llama.cpp recipe ${recipeId} does not resolve an enabled serving preset.`,
    };
  }
  const resolutions = presetIds.map((presetId) => ({
    presetId,
    resolution: resolveManagedInferenceServing(
      {
        readinessReports: [{ nodeId: os.hostname(), report }],
        topologyQualifications: [],
        intent: { provider: "install-llama-cpp", preset: presetId },
      },
      catalog,
    ),
  }));
  const selected = resolutions.filter(({ resolution }) => resolution.outcome === "selected");
  if (selected.length !== 1) {
    if (selected.length > 1) {
      return {
        kind: "rejected",
        reason: `Managed llama.cpp recipe ${recipeId} matches more than one serving preset: ${selected.map(({ presetId }) => presetId).join(", ")}.`,
      };
    }
    return {
      kind: "rejected",
      reason: `Managed llama.cpp recipe ${recipeId} does not match this host: ${resolutions
        .map(({ presetId, resolution }) =>
          resolution.outcome === "selected"
            ? `${presetId}: matched unexpectedly`
            : `${presetId}: ${resolution.message}`,
        )
        .join("; ")}`,
    };
  }
  const resolution = selected[0]!.resolution;
  return validatedLlamaCppSelection(resolution, recipeId);
}
