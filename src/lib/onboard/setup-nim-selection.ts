// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type SetupNimSelectionBackNavigation = Readonly<{ kind: "NEMOCLAW_BACK_TO_SELECTION" }>;

export type SetupNimSelectionState<THermesAuthMethod = unknown> = {
  model: string | SetupNimSelectionBackNavigation | null;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: THermesAuthMethod | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  allowToolsIncompatible: boolean;
};

export type CloudFallbackConfig = {
  providerName: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  defaultModel: string;
};

export function applyCloudFallbackSelection(
  state: SetupNimSelectionState,
  cloudConfig: CloudFallbackConfig,
): void {
  // Source boundary: fallback may run after a local Ollama/NIM/vLLM branch
  // accepted provider-specific tool constraints. Cloud fallback is a fresh
  // provider selection, so clear local-only compatibility state here.
  state.provider = cloudConfig.providerName;
  state.endpointUrl = cloudConfig.endpointUrl;
  state.credentialEnv = cloudConfig.credentialEnv;
  state.model = cloudConfig.defaultModel;
  state.preferredInferenceApi = null;
  state.nimContainer = null;
  state.allowToolsIncompatible = false;
}

export function clearNimContainerBeforeRetry(state: SetupNimSelectionState): void {
  state.nimContainer = null;
}

type ProviderChoice = {
  key: string;
};

export function requireProviderChoice<T extends ProviderChoice>(selected: T | undefined): T {
  if (!selected) {
    console.error("  No provider was selected.");
    process.exit(1);
  }
  return selected;
}

type RemoteProviderConfig = {
  label: string;
  endpointUrl: string;
  helpUrl: string | null;
};

type ProbeAuthMode = "bearer" | "query-param" | undefined;

type ProbeOptions = {
  requireResponsesToolCalling?: boolean;
  skipResponsesProbe?: boolean;
  authMode?: ProbeAuthMode;
};

type ValidationResult =
  | { ok: true; api: string | null; retry?: never }
  | { ok: false; api?: string; retry?: "credential" | "retry" | "model" | "selection" | string };

type RemoteModelValidationResult = "selected" | "retry-model" | "retry-selection";

type RemoteModelValidatorDeps = {
  OPENAI_ENDPOINT_URL: string;
  ANTHROPIC_ENDPOINT_URL: string;
  requireValue: <T>(value: T | null | undefined, message: string) => T;
  isBackToSelection: (value: unknown) => value is SetupNimSelectionBackNavigation;
  validateCustomOpenAiLikeSelection: (
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null,
  ) => Promise<ValidationResult>;
  validateCustomAnthropicSelection: (
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null,
  ) => Promise<ValidationResult>;
  validateAnthropicSelectionWithRetryMessage: (
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    retryMessage: string,
    helpUrl: string | null,
  ) => Promise<ValidationResult>;
  validateOpenAiLikeSelection: (
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null,
    retryMessage?: string,
    helpUrl?: string | null,
    options?: ProbeOptions,
  ) => Promise<ValidationResult>;
  shouldRequireResponsesToolCalling: (provider: string) => boolean;
  shouldSkipResponsesProbe: (provider: string) => boolean;
  getProbeAuthMode: (provider: string) => ProbeAuthMode;
};

type ValidateSelectedRemoteModelArgs = {
  selected: ProviderChoice;
  remoteConfig: RemoteProviderConfig;
  state: SetupNimSelectionState;
  selectedCredentialEnv: string;
};

function shouldRetryModel(validation: ValidationResult): boolean {
  return (
    !validation.ok &&
    (validation.retry === "credential" ||
      validation.retry === "retry" ||
      validation.retry === "model")
  );
}

export function createRemoteModelValidator(deps: RemoteModelValidatorDeps): {
  validateSelectedRemoteModel: (
    args: ValidateSelectedRemoteModelArgs,
  ) => Promise<RemoteModelValidationResult>;
} {
  return {
    validateSelectedRemoteModel: async ({
      selected,
      remoteConfig,
      state,
      selectedCredentialEnv,
    }) => {
      const selectedModel = deps.requireValue(
        deps.isBackToSelection(state.model) ? null : state.model,
        `Missing model for ${remoteConfig.label}`,
      );
      if (selected.key === "custom") {
        const validation = await deps.validateCustomOpenAiLikeSelection(
          remoteConfig.label,
          state.endpointUrl || deps.OPENAI_ENDPOINT_URL,
          selectedModel,
          selectedCredentialEnv,
          remoteConfig.helpUrl,
        );
        if (validation.ok) {
          const explicitApi = (process.env.NEMOCLAW_PREFERRED_API || "").trim().toLowerCase();
          if (
            explicitApi &&
            explicitApi !== "openai-completions" &&
            explicitApi !== "chat-completions"
          ) {
            state.preferredInferenceApi = validation.api;
          } else {
            if (validation.api !== "openai-completions") {
              console.log(
                "  ℹ Using chat completions API (compatible endpoints may not support the Responses API developer role)",
              );
            }
            state.preferredInferenceApi = "openai-completions";
          }
          return "selected";
        }
        if (shouldRetryModel(validation)) {
          return "retry-model";
        }
        return validation.retry === "selection" ? "retry-selection" : "retry-model";
      }

      if (selected.key === "anthropicCompatible") {
        const validation = await deps.validateCustomAnthropicSelection(
          remoteConfig.label,
          state.endpointUrl || deps.ANTHROPIC_ENDPOINT_URL,
          selectedModel,
          selectedCredentialEnv,
          remoteConfig.helpUrl,
        );
        if (validation.ok) {
          state.preferredInferenceApi = validation.api;
          return "selected";
        }
        if (shouldRetryModel(validation)) {
          return "retry-model";
        }
        return validation.retry === "selection" ? "retry-selection" : "retry-model";
      }

      const retryMessage = "Please choose a provider/model again.";
      if (selected.key === "anthropic") {
        const validation = await deps.validateAnthropicSelectionWithRetryMessage(
          remoteConfig.label,
          state.endpointUrl || deps.ANTHROPIC_ENDPOINT_URL,
          selectedModel,
          selectedCredentialEnv,
          retryMessage,
          remoteConfig.helpUrl,
        );
        if (validation.ok) {
          state.preferredInferenceApi = validation.api;
          return "selected";
        }
        if (shouldRetryModel(validation)) {
          return "retry-model";
        }
        return "retry-selection";
      }

      const validation = await deps.validateOpenAiLikeSelection(
        remoteConfig.label,
        deps.requireValue(state.endpointUrl, `Missing endpoint URL for ${remoteConfig.label}`),
        selectedModel,
        selectedCredentialEnv,
        retryMessage,
        remoteConfig.helpUrl,
        {
          requireResponsesToolCalling: deps.shouldRequireResponsesToolCalling(state.provider),
          skipResponsesProbe: deps.shouldSkipResponsesProbe(state.provider),
          authMode: deps.getProbeAuthMode(state.provider),
        },
      );
      if (validation.ok) {
        state.preferredInferenceApi = validation.api;
        return "selected";
      }
      if (shouldRetryModel(validation)) {
        return "retry-model";
      }
      return "retry-selection";
    },
  };
}
