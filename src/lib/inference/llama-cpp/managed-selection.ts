// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { dockerContextIsDefaultFromBuild } from "../../adapters/docker/client-isolation";
import { getBuildIdentity } from "../../core/version";
import {
  type CollectHostObservationsOptions,
  createHostReadinessReport,
} from "../../readiness/host";
import type { SystemReadinessReport } from "../../readiness/types";
import type { GpuDetection } from "../nim";
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

export interface ManagedLlamaCppDiscoveryResult {
  readonly resolution: ManagedLlamaCppSelectionResult;
  readonly choices: readonly ManagedLlamaCppSelectionChoice[];
}

const N1X_WSL_RECIPE_ID = "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1";

type ManagedLlamaCppSelectionOptions = {
  readonly dockerContextIsDefault?: typeof dockerContextIsDefaultFromBuild;
  readonly runtimeProviderId?: string;
};

function n1xWslDockerLocalityFailure(
  env: NodeJS.ProcessEnv,
  options: ManagedLlamaCppSelectionOptions,
): string | null {
  return (options.dockerContextIsDefault ?? dockerContextIsDefaultFromBuild)(env)
    ? null
    : "Managed N1x WSL llama.cpp requires DOCKER_HOST to be unset and the effective Docker context to be default.";
}

function dockerQualifiedPresetRuntimeFailure(
  runtimeProviderId: string | undefined,
  selection: ResolvedLlamaCppInferenceSelection,
): string | null {
  const requiresDocker = selection.preset.spec.requirements.all.some(
    (requirement) =>
      "readiness" in requirement &&
      requirement.readiness.kind === "observation" &&
      requirement.readiness.id === "host.docker.runtime",
  );
  const resolvedProvider = String(runtimeProviderId ?? "").trim().toLowerCase();
  return requiresDocker && resolvedProvider && resolvedProvider !== "docker"
    ? `Managed llama.cpp preset ${selection.preset.metadata.id} requires the Docker runtime provider selected by its readiness qualification; the resolved runtime provider is ${resolvedProvider}.`
    : null;
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

function managedLlamaCppChoiceEligibilityFailure(
  choice: ManagedLlamaCppSelectionChoice,
  env: NodeJS.ProcessEnv,
  options: ManagedLlamaCppSelectionOptions,
): string | null {
  const runtimeFailure = dockerQualifiedPresetRuntimeFailure(
    options.runtimeProviderId,
    choice.selection,
  );
  if (runtimeFailure) return runtimeFailure;
  return (
    choice.selection.recipe.metadata.id === N1X_WSL_RECIPE_ID &&
    n1xWslDockerLocalityFailure(env, options)
  ) || null;
}

function resolveManagedLlamaCppSelectionFromChoices(
  env: NodeJS.ProcessEnv,
  catalog: CompiledManagedInferenceCatalog,
  report: SystemReadinessReport,
  options: ManagedLlamaCppSelectionOptions,
  automaticChoices: readonly ManagedLlamaCppSelectionChoice[],
  automaticChoiceFailures?: ReadonlyMap<string, string | null>,
): ManagedLlamaCppSelectionResult {
  const requestedRecipeId = String(env[LLAMA_CPP_RECIPE_ENV] ?? "").trim();
  if (requestedRecipeId === N1X_WSL_RECIPE_ID) {
    const localityFailure = n1xWslDockerLocalityFailure(env, options);
    if (localityFailure) return { kind: "rejected", reason: localityFailure };
  }
  if (String(env.NEMOCLAW_MODEL ?? "").trim()) {
    return {
      kind: "rejected",
      reason: `NEMOCLAW_MODEL cannot override the served model in ${LLAMA_CPP_RECIPE_ENV}.`,
    };
  }
  if (!requestedRecipeId) {
    if (automaticChoices.length === 0) {
      return {
        kind: "rejected",
        reason: "No automatic managed llama.cpp preset matches this host.",
      };
    }
    const highestPriority = automaticChoices[0]!.priority;
    const highestPriorityChoices = automaticChoices.filter(
      ({ priority }) => priority === highestPriority,
    );
    if (highestPriorityChoices.length > 1) {
      return {
        kind: "rejected",
        reason: `Automatic managed llama.cpp selection is ambiguous at priority ${String(highestPriority)}: ${highestPriorityChoices
          .map(({ selection }) => selection.preset.metadata.id)
          .join(", ")}.`,
      };
    }
    const selection = highestPriorityChoices[0]!.selection;
    const choiceFailure = automaticChoiceFailures?.has(selection.preset.metadata.id)
      ? automaticChoiceFailures.get(selection.preset.metadata.id)
      : managedLlamaCppChoiceEligibilityFailure(highestPriorityChoices[0]!, env, options);
    if (choiceFailure) return { kind: "rejected", reason: choiceFailure };
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
  const validated = validatedLlamaCppSelection(resolution, recipeId);
  if (validated.kind === "rejected") return validated;
  const runtimeProviderFailure = dockerQualifiedPresetRuntimeFailure(
    options.runtimeProviderId,
    validated.selection,
  );
  return runtimeProviderFailure ? { kind: "rejected", reason: runtimeProviderFailure } : validated;
}

function choicesIncludingResolution(
  choices: readonly ManagedLlamaCppSelectionChoice[],
  resolution: ManagedLlamaCppSelectionResult,
): readonly ManagedLlamaCppSelectionChoice[] {
  if (
    resolution.kind === "rejected" ||
    choices.some(
      ({ selection }) => selection.recipe.metadata.id === resolution.selection.recipe.metadata.id,
    )
  ) {
    return choices;
  }
  return Object.freeze(
    [
      ...choices,
      { priority: resolution.selection.preset.spec.priority, selection: resolution.selection },
    ].sort(
      (left, right) =>
        right.priority - left.priority ||
        left.selection.preset.metadata.id.localeCompare(right.selection.preset.metadata.id),
    ),
  );
}

/** Discover menu choices and the default selection through one readiness/provider authority. */
export function discoverManagedLlamaCppSelections(
  env: NodeJS.ProcessEnv = process.env,
  catalog: CompiledManagedInferenceCatalog = loadManagedInferenceCatalog(),
  report: SystemReadinessReport = createHostReadinessReport(getBuildIdentity()),
  options: ManagedLlamaCppSelectionOptions = {},
): ManagedLlamaCppDiscoveryResult {
  const explicitRequest = Boolean(
    String(env[LLAMA_CPP_RECIPE_ENV] ?? "").trim() || String(env.NEMOCLAW_MODEL ?? "").trim(),
  );
  if (explicitRequest) {
    const resolution = resolveManagedLlamaCppSelectionFromChoices(
      env,
      catalog,
      report,
      options,
      [],
    );
    return {
      resolution,
      choices: choicesIncludingResolution([], resolution),
    };
  }
  let choices: readonly ManagedLlamaCppSelectionChoice[];
  try {
    choices = listManagedLlamaCppSelectionChoices(catalog, report);
  } catch (error) {
    return {
      choices: [],
      resolution: {
        kind: "rejected",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const choiceFailures = new Map(
    choices.map((choice) => [
      choice.selection.preset.metadata.id,
      managedLlamaCppChoiceEligibilityFailure(choice, env, options),
    ]),
  );
  const eligibleChoices = choices.filter(
    (choice) => choiceFailures.get(choice.selection.preset.metadata.id) === null,
  );
  const resolutionChoices = eligibleChoices.length > 0 ? eligibleChoices : choices;
  const resolution = resolveManagedLlamaCppSelectionFromChoices(
    env,
    catalog,
    report,
    options,
    resolutionChoices,
    choiceFailures,
  );
  return {
    resolution,
    choices: choicesIncludingResolution(eligibleChoices, resolution),
  };
}

/** Resolve one managed llama.cpp recipe through fresh canonical host readiness. */
export function resolveManagedLlamaCppSelection(
  env: NodeJS.ProcessEnv = process.env,
  catalog: CompiledManagedInferenceCatalog = loadManagedInferenceCatalog(),
  report: SystemReadinessReport = createHostReadinessReport(getBuildIdentity()),
  options: ManagedLlamaCppSelectionOptions = {},
): ManagedLlamaCppSelectionResult {
  return discoverManagedLlamaCppSelections(env, catalog, report, options).resolution;
}

/** Resolve managed selection with the GPU proof already admitted by onboarding preflight. */
export function resolveManagedLlamaCppSelectionForGpu(
  env: NodeJS.ProcessEnv | undefined,
  gpu: GpuDetection | null,
  catalog: CompiledManagedInferenceCatalog = loadManagedInferenceCatalog(),
  collectionOptions: Omit<
    CollectHostObservationsOptions,
    "detectGpu" | "wslDockerDesktopGpuProofPassed"
  > = {},
  selectionOptions: ManagedLlamaCppSelectionOptions = {},
): ManagedLlamaCppSelectionResult {
  const report = createHostReadinessReport(getBuildIdentity(), {
    ...collectionOptions,
    ...(gpu ? { detectGpu: () => gpu } : {}),
    ...(gpu?.wslDockerDesktopGpuProofPassed === undefined
      ? {}
      : { wslDockerDesktopGpuProofPassed: gpu.wslDockerDesktopGpuProofPassed }),
  });
  return resolveManagedLlamaCppSelection(env, catalog, report, selectionOptions);
}

/** Discover managed choices with the GPU proof already admitted by onboarding preflight. */
export function discoverManagedLlamaCppSelectionsForGpu(
  env: NodeJS.ProcessEnv | undefined,
  gpu: GpuDetection | null,
  catalog: CompiledManagedInferenceCatalog = loadManagedInferenceCatalog(),
  collectionOptions: Omit<
    CollectHostObservationsOptions,
    "detectGpu" | "wslDockerDesktopGpuProofPassed"
  > = {},
  selectionOptions: ManagedLlamaCppSelectionOptions = {},
): ManagedLlamaCppDiscoveryResult {
  const report = createHostReadinessReport(getBuildIdentity(), {
    ...collectionOptions,
    ...(gpu ? { detectGpu: () => gpu } : {}),
    ...(gpu?.wslDockerDesktopGpuProofPassed === undefined
      ? {}
      : { wslDockerDesktopGpuProofPassed: gpu.wslDockerDesktopGpuProofPassed }),
  });
  return discoverManagedLlamaCppSelections(env, catalog, report, selectionOptions);
}
