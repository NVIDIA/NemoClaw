// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { installManagedLlamaCpp } from "../../inference/llama-cpp/managed-installer";
import { materializeHostLocalVllmSelection } from "../../inference/serving/host-local-vllm-selection";
import type { ResolvedHostLocalInferenceSelection } from "../../inference/serving/types";
import type { VllmProfile } from "../../inference/vllm";
import { VLLM_EXTRA_ARGS_ENV } from "../../inference/vllm-models";
import type { SetupNimSelectionResult, SetupNimSelectionState } from "../setup-nim-flow";
import type { LocalModelProfilePlan } from "./plan";

export interface LocalModelProfileOnboarderDeps {
  env?: NodeJS.ProcessEnv;
  installVllm(
    profile: VllmProfile,
    options: {
      hasImage: boolean;
      nonInteractive: boolean;
      promptFn: (question: string) => Promise<string>;
      beforeInstall?: (modelId: string) => void;
    },
  ): Promise<{ ok: boolean }>;
  installLlamaCpp: typeof installManagedLlamaCpp;
  handleVllmSelection(
    state: SetupNimSelectionState,
    options?: { managedInstall?: boolean; sparkHost?: boolean },
  ): Promise<SetupNimSelectionResult>;
  handleLlamaCppSelection(
    state: SetupNimSelectionState,
    requestedModel: string | null,
    recoveredModel: string | null,
  ): Promise<SetupNimSelectionResult>;
  prompt(message: string): Promise<string>;
  error(message: string): void;
}

export interface LocalModelProfileHostState {
  hasVllmImage: boolean;
  sparkHost: boolean;
  vllmProfile: VllmProfile | null;
  vllmRunning: boolean;
}

/** One dedicated, non-interactive onboarder for both gated runtime combinations. */
export function createLocalModelProfileOnboarder(deps: LocalModelProfileOnboarderDeps) {
  const env = deps.env ?? process.env;
  return async function onboardLocalModelProfile(
    plan: LocalModelProfilePlan,
    host: LocalModelProfileHostState,
    state: SetupNimSelectionState,
  ): Promise<SetupNimSelectionResult> {
    if (!host.sparkHost) {
      deps.error("  The local model profile requires a qualified DGX Spark host.");
      return "retry-selection";
    }

    if (plan.runtime === "vllm") {
      if (!host.vllmProfile || host.vllmProfile.platform !== "spark") {
        deps.error("  No DGX Spark vLLM install profile is available on this host.");
        return "retry-selection";
      }
      if (host.vllmRunning) {
        deps.error("  Stop the existing vLLM server before installing the local model profile.");
        return "retry-selection";
      }
      if (
        String(env.NEMOCLAW_VLLM_MODEL ?? "").trim() ||
        String(env[VLLM_EXTRA_ARGS_ENV] ?? "").trim() ||
        String(env.NEMOCLAW_VLLM_PORT ?? "").trim()
      ) {
        deps.error(
          "  The local model profile does not accept vLLM model, port, or serve overrides.",
        );
        return "retry-selection";
      }
      let materialized: ReturnType<typeof materializeHostLocalVllmSelection>;
      try {
        materialized = materializeHostLocalVllmSelection(
          {
            outcome: "selected",
            selection: "explicit",
            catalogDigest: plan.catalogDigest,
            presetDigest: plan.presetDigest,
            recipeDigest: plan.recipeDigest,
            preset: plan.preset,
            recipe: plan.recipe,
          } satisfies ResolvedHostLocalInferenceSelection,
          host.vllmProfile,
        );
      } catch (error) {
        deps.error(
          `  Local model profile materialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return "retry-selection";
      }
      const result = await deps.installVllm(materialized.profile, {
        hasImage: host.hasVllmImage,
        nonInteractive: true,
        promptFn: deps.prompt,
        beforeInstall: (modelId) => {
          state.provider = "vllm-local";
          state.model = modelId;
          state.endpointUrl = null;
          state.credentialEnv = null;
          state.preferredInferenceApi = "openai-completions";
          state.assertRouteCompatible?.();
        },
      });
      if (!result.ok) return "retry-selection";
      return deps.handleVllmSelection(state, { managedInstall: true, sparkHost: true });
    }

    const result = await deps.installLlamaCpp(plan.recipe);
    if (!result.ok) {
      deps.error(`  llama.cpp install failed: ${result.reason}`);
      return "retry-selection";
    }
    state.model = result.model;
    return deps.handleLlamaCppSelection(state, result.model, null);
  };
}
