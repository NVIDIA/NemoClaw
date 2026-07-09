// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenAiLikeAuthMode } from "../adapters/http/auth-config";
import type { ModelPromptResult } from "../inference/model-prompts";
import { getProbeExtraHeaders } from "../inference/onboard-probes";
import { OPENROUTER_CREDENTIAL_ENV } from "../inference/openrouter";
import { validateOpenRouterApiKeyValue } from "../validation";
import type { SetupNimSelectionState } from "./setup-nim-selection";
import type { ModelValidationResult } from "./types";

type OpenAiLikeModelValidationOptions = {
  authMode?: OpenAiLikeAuthMode;
  extraHeaders?: readonly string[];
};

type RemoteProviderConfig = {
  endpointUrl: string;
  label: string;
};

type ValidateOpenAiLikeModel = (
  label: string,
  endpointUrl: string,
  model: string,
  apiKey: string,
  options?: { extraHeaders?: readonly string[] },
) => ModelValidationResult;

export function isOpenRouterProvider(selectedKey: string): boolean {
  return selectedKey === "openrouter";
}

export function isOpenAiLikeRemoteProvider(selectedKey: string): boolean {
  return selectedKey === "openai" || selectedKey === "gemini" || isOpenRouterProvider(selectedKey);
}

export function credentialValidatorForProvider(
  selectedKey: string,
): ((value: string) => string | null) | null {
  return isOpenRouterProvider(selectedKey) ? validateOpenRouterApiKeyValue : null;
}

export function openAiLikeModelValidationOptions(
  provider: string,
  authMode: OpenAiLikeAuthMode | undefined,
): OpenAiLikeModelValidationOptions {
  return {
    ...(authMode ? { authMode } : {}),
    extraHeaders: getProbeExtraHeaders(provider),
  };
}

export function validateNonInteractiveCredential(args: {
  selectedKey: string;
  selectedCredentialEnv: string;
  isNonInteractive: boolean;
  reuseGatewayCredentialWithoutLocalKey?: boolean;
  resolveProviderCredential: (envName: string) => string | null;
  getCredential: (envName: string) => string | null;
  error: (message: string) => void;
  exitProcess: (code: number) => never;
}): void {
  if (
    !args.isNonInteractive ||
    !isOpenRouterProvider(args.selectedKey) ||
    args.reuseGatewayCredentialWithoutLocalKey
  ) {
    return;
  }
  const credentialValue =
    args.resolveProviderCredential(args.selectedCredentialEnv) ||
    args.getCredential(args.selectedCredentialEnv) ||
    "";
  const validationError = validateOpenRouterApiKeyValue(credentialValue);
  if (!validationError) return;
  args.error(validationError);
  args.exitProcess(1);
}

export async function selectModel(args: {
  state: SetupNimSelectionState;
  requestedModel: string | null;
  recoveredFromSandbox: boolean;
  recoveredModel: string | null;
  remoteConfig: RemoteProviderConfig;
  validateOpenAiLikeModel: ValidateOpenAiLikeModel;
}): Promise<ModelPromptResult> {
  return args.state.openRouterFeaturedModels!.select(
    args.requestedModel || (typeof args.state.model === "string" ? args.state.model : null),
    args.recoveredFromSandbox ? args.recoveredModel : null,
    false,
    process.env.NEMOCLAW_MODEL,
    {
      cloudModelMenuLabel: "OpenRouter cloud models",
      manualCredentialEnv: OPENROUTER_CREDENTIAL_ENV,
      manualCredentialMissingMessage:
        "  OPENROUTER_API_KEY is required before validating a custom OpenRouter model.",
      manualModelLabel: "OpenRouter",
      validateCloudModelFn: (model, apiKey) =>
        args.validateOpenAiLikeModel(
          args.remoteConfig.label,
          args.state.endpointUrl || args.remoteConfig.endpointUrl,
          model,
          apiKey,
          { extraHeaders: getProbeExtraHeaders(args.state.provider) },
        ),
    },
  );
}
