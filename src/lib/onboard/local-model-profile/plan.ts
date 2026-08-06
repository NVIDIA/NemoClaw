// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  CompiledServingCatalog,
  HostLocalInferenceServingRecipe,
  LlamaCppServingRecipe,
  ManagedInferenceServingPreset,
  ServingDefinitionKind,
  ServingRecipe,
} from "../../inference/serving/types";

export const LOCAL_MODEL_PROFILE_GATE = "local-model-profile-v1" as const;
export const LOCAL_MODEL_PROFILE_ENABLED_ENV = "NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE" as const;
export const LOCAL_MODEL_PROFILE_RUNTIME_ENV = "NEMOCLAW_LOCAL_MODEL_RUNTIME" as const;

export type LocalModelProfileRuntime = "vllm" | "llama-cpp";

export type LocalModelProfilePlan =
  | {
      readonly runtime: "vllm";
      readonly catalogDigest: string;
      readonly presetDigest: string;
      readonly recipeDigest: string;
      readonly preset: ManagedInferenceServingPreset;
      readonly recipe: HostLocalInferenceServingRecipe;
    }
  | {
      readonly runtime: "llama-cpp";
      readonly catalogDigest: string;
      readonly presetDigest: string;
      readonly recipeDigest: string;
      readonly preset: ManagedInferenceServingPreset;
      readonly recipe: LlamaCppServingRecipe;
    };

function requestedRuntime(env: NodeJS.ProcessEnv): LocalModelProfileRuntime | null {
  const raw = String(env[LOCAL_MODEL_PROFILE_RUNTIME_ENV] ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw === "vllm" || raw === "llama-cpp") return raw;
  throw new Error(`${LOCAL_MODEL_PROFILE_RUNTIME_ENV} must be 'vllm' or 'llama-cpp'.`);
}

function recipeForPreset(
  catalog: CompiledServingCatalog,
  preset: ManagedInferenceServingPreset,
): ServingRecipe {
  const recipes = catalog.recipes.filter(
    ({ metadata }) => metadata.id === preset.spec.plan.recipeRef,
  );
  if (recipes.length !== 1 || recipes[0]!.spec.backend !== preset.spec.plan.backend) {
    throw new Error(`Serving preset ${preset.metadata.id} does not resolve one matching recipe.`);
  }
  return recipes[0]!;
}

function isHostLocalVllmRecipe(recipe: ServingRecipe): recipe is HostLocalInferenceServingRecipe {
  return (
    recipe.spec.backend === "vllm" &&
    recipe.spec.execution.materializerRef === "vllm.host-local/v1" &&
    recipe.spec.execution.lifecycleRef === "vllm.host-local.lifecycle/v1"
  );
}

function isManagedPreset(
  preset: CompiledServingCatalog["presets"][number],
): preset is ManagedInferenceServingPreset {
  return preset.spec.requirements !== undefined;
}

function definitionDigest(
  catalog: CompiledServingCatalog,
  kind: ServingDefinitionKind,
  id: string,
): string {
  const matches = catalog.sources.filter((source) => source.kind === kind && source.id === id);
  if (matches.length !== 1) {
    throw new Error(`Serving ${kind} ${id} does not have one catalog provenance record.`);
  }
  return matches[0]!.digest;
}

function isLlamaCppRecipe(recipe: ServingRecipe): recipe is LlamaCppServingRecipe {
  return (
    recipe.spec.backend === "install-llama-cpp" && recipe.spec.providerId === "llama-cpp-local"
  );
}

/** Resolve the disabled serving preset only after the dedicated feature gate is enabled. */
export function resolveLocalModelProfilePlan(
  catalog: CompiledServingCatalog,
  env: NodeJS.ProcessEnv = process.env,
): LocalModelProfilePlan | null {
  const runtime = requestedRuntime(env);
  const enabled = String(env[LOCAL_MODEL_PROFILE_ENABLED_ENV] ?? "").trim() === "1";
  if (!enabled) {
    if (runtime) {
      throw new Error(
        `${LOCAL_MODEL_PROFILE_RUNTIME_ENV} requires ${LOCAL_MODEL_PROFILE_ENABLED_ENV}=1.`,
      );
    }
    return null;
  }
  if (!runtime) {
    throw new Error(
      `${LOCAL_MODEL_PROFILE_RUNTIME_ENV} is required when ${LOCAL_MODEL_PROFILE_ENABLED_ENV}=1.`,
    );
  }

  const backend = runtime === "vllm" ? "vllm" : "install-llama-cpp";
  const presets = catalog.presets.filter(
    (preset): preset is ManagedInferenceServingPreset =>
      isManagedPreset(preset) &&
      preset.spec.featureGate === LOCAL_MODEL_PROFILE_GATE &&
      preset.spec.selection === "disabled" &&
      preset.spec.plan.backend === backend,
  );
  if (presets.length !== 1) {
    throw new Error(
      `The ${runtime} local model profile requires one disabled serving preset; found ${String(presets.length)}.`,
    );
  }
  const preset = presets[0]!;
  const recipe = recipeForPreset(catalog, preset);
  const digests = {
    catalogDigest: catalog.catalogDigest,
    presetDigest: definitionDigest(catalog, "ServingPreset", preset.metadata.id),
    recipeDigest: definitionDigest(catalog, "ServingRecipe", recipe.metadata.id),
  };
  if (runtime === "vllm" && isHostLocalVllmRecipe(recipe)) {
    return { runtime, ...digests, preset, recipe };
  }
  if (runtime === "llama-cpp" && isLlamaCppRecipe(recipe)) {
    return { runtime, ...digests, preset, recipe };
  }
  throw new Error(`The ${runtime} local model profile selects an incompatible serving recipe.`);
}
