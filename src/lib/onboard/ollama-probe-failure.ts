// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ApplyOllamaRuntimeContextWindowResult } from "../inference/ollama-runtime-context";
import { abortNonInteractive } from "./non-interactive-abort";
import { isOllamaProviderPinned } from "./ollama-startup";

export interface OllamaProbeFailureInput {
  ok: boolean;
  message?: string;
  daemonFailure?: boolean;
}

export type OllamaProbeFailureAction = "back-to-selection" | "continue";

type SelectedOllamaModel = {
  outcome: "selected";
  model: string;
  allowToolsIncompatible: boolean;
};

export type OllamaModelSelectionOutcome = SelectedOllamaModel | { outcome: "back-to-selection" };

/** Finish Ollama selection, returning to provider selection on an interactive context failure. */
export function completeOllamaRuntimeContextSelection(
  result: ApplyOllamaRuntimeContextWindowResult,
  selected: SelectedOllamaModel,
  isNonInteractive: () => boolean,
): OllamaModelSelectionOutcome {
  if (result.ok) return selected;
  if (isNonInteractive()) abortNonInteractive(result.message);
  console.error(`  ${result.message}`);
  if (isOllamaProviderPinned()) process.exit(1);
  console.log("  Returning to provider selection.");
  console.log("");
  return { outcome: "back-to-selection" };
}

/**
 * Centralizes selectAndValidateOllamaModel's reaction to a failed Ollama
 * probe. Lives outside onboard.ts so the codebase growth guardrail stays
 * green and so the sequence has a focused test surface. (#4365)
 *
 * - daemonFailure → the Ollama daemon / runner itself is broken. Pinned-
 *   provider runs exit, non-interactive runs abort, interactive runs escape
 *   to provider selection (picking another Ollama tag would loop on the
 *   same failure).
 * - otherwise → the chosen model is unsuitable. Non-interactive runs
 *   abort; interactive runs continue to the next inner-loop prompt for a
 *   different Ollama tag (existing behavior).
 */
export function handleOllamaProbeFailure(
  probe: OllamaProbeFailureInput,
  selectedModel: string,
  isNonInteractive: () => boolean,
): OllamaProbeFailureAction {
  console.error(`  ${probe.message}`);
  if (probe.daemonFailure) {
    if (isOllamaProviderPinned()) {
      console.error(
        "  NEMOCLAW_PROVIDER pins onboarding to Ollama but the Ollama model runner is unhealthy; refusing to loop on Ollama model selection.",
      );
      process.exit(1);
    }
    if (isNonInteractive()) {
      abortNonInteractive(
        `Ollama daemon is unhealthy for model '${selectedModel}'.`,
        "Pick a non-Ollama provider, restart Ollama, or rerun with NEMOCLAW_PROVIDER set explicitly.",
      );
    }
    console.log(
      "  Ollama itself appears unavailable — selecting a different Ollama model would hit the same failure.",
    );
    console.log(
      "  Returning to provider selection; choose a non-Ollama provider to continue. (#4365)",
    );
    console.log("");
    return "back-to-selection";
  }
  if (isNonInteractive()) abortNonInteractive(`Ollama model '${selectedModel}' unavailable.`);
  console.log("  Choose a different Ollama model or select Other.");
  console.log("");
  return "continue";
}
