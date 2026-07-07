// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SetupNimSelectionResult, SetupNimSelectionState } from "./setup-nim-flow";

type VllmModels = { data?: Array<{ id?: unknown }> };

export interface SetupNimVllmDeps {
  VLLM_PORT: number;
  runCapture(args: string[], options: { ignoreError: boolean }): string;
  getLocalProviderBaseUrl(provider: string): string | null;
  getLocalProviderValidationBaseUrl(provider: string): string | null;
  isSafeModelId(model: string): boolean;
  requireValue<T>(value: T | null | undefined, message: string): T;
  validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null,
  ): Promise<{ ok: boolean; retry?: string; api?: string | null }>;
  applyVllmRuntimeContextWindow(models: VllmModels, model: string): void;
  exitProcess(code: number): never;
}

export function createSetupNimVllmHandler(
  deps: SetupNimVllmDeps,
): (state: SetupNimSelectionState) => Promise<SetupNimSelectionResult> {
  return async function handleVllmSelection(
    state: SetupNimSelectionState,
  ): Promise<SetupNimSelectionResult> {
    console.log(`  ✓ Using existing vLLM on localhost:${deps.VLLM_PORT}`);
    state.provider = "vllm-local";
    state.credentialEnv = null;
    state.endpointUrl = deps.getLocalProviderBaseUrl(state.provider);
    if (!state.endpointUrl) {
      console.error("  Local vLLM base URL could not be determined.");
      deps.exitProcess(1);
    }
    state.preferredInferenceApi = "openai-completions";
    state.assertRouteCompatible?.();
    const requiredModel = typeof state.model === "string" ? state.model : null;

    const raw = deps.runCapture(["curl", "-sf", `http://127.0.0.1:${deps.VLLM_PORT}/v1/models`], {
      ignoreError: true,
    });
    let models: VllmModels;
    try {
      models = JSON.parse(raw);
    } catch {
      console.error(
        `  Could not query vLLM models endpoint. Is vLLM running on localhost:${deps.VLLM_PORT}?`,
      );
      deps.exitProcess(1);
    }
    const detectedModel =
      models.data && models.data.length > 0 && typeof models.data[0]?.id === "string"
        ? models.data[0].id
        : null;
    if (!detectedModel) {
      console.error("  Could not detect model from vLLM. Please specify manually.");
      deps.exitProcess(1);
    }
    if (!deps.isSafeModelId(detectedModel)) {
      console.error("  Detected vLLM model ID contains invalid characters.");
      deps.exitProcess(1);
    }
    if (requiredModel && detectedModel !== requiredModel) {
      console.error(
        `  Detected vLLM model '${detectedModel}' does not match the shared gateway route '${requiredModel}'.`,
      );
      deps.exitProcess(1);
    }
    state.model = detectedModel;
    state.assertRouteCompatible?.();
    console.log(`  Detected model: ${state.model}`);

    const validationBaseUrl = deps.getLocalProviderValidationBaseUrl(state.provider);
    if (!validationBaseUrl) {
      console.error("  Local vLLM validation URL could not be determined.");
      deps.exitProcess(1);
    }
    const validation = await deps.validateOpenAiLikeSelection(
      "Local vLLM",
      validationBaseUrl,
      deps.requireValue(state.model, "Expected a detected vLLM model"),
      null,
    );
    if (validation.retry === "selection" || validation.retry === "model" || !validation.ok) {
      return "retry-selection";
    }

    deps.applyVllmRuntimeContextWindow(models, state.model);
    if (validation.api !== "openai-completions") {
      console.log(
        "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
      );
    }
    state.preferredInferenceApi = "openai-completions";
    return "selected";
  };
}
