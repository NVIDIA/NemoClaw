// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellInferenceRouteMutator } from "../adapters/openshell/inference-route";
import {
  BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV,
  BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV,
  classifyCustomAnthropicEndpoint,
  hasBedrockRuntimeAwsAuthEnv,
  isBedrockRuntimeEndpoint,
} from "../inference/bedrock-runtime";
import { ensureBedrockRuntimeAdapter } from "../inference/bedrock-runtime-adapter";
import type { BackToSelection } from "../navigation";
import * as registry from "../state/registry";
import type { UpsertProvider } from "./inference-providers/types";

type SetupInferenceResult = { ok: true; retry?: undefined } | { retry: "selection" };

type BedrockRuntimeDependencies = {
  exitProcess: (code: number) => never;
  error: (message: string) => void;
  log: (message: string) => void;
};

function normalizeCredentialValue(value: unknown): string {
  return String(value ?? "").trim();
}

function getExplicitCompatibleCredential(credentialEnv: string | null | undefined): string | null {
  if (!credentialEnv) return null;
  return normalizeCredentialValue(process.env[credentialEnv]) || null;
}

function printMissingBedrockAuth(error: (message: string) => void): void {
  error(
    `  ${BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV}, AWS_PROFILE, IAM environment credentials, or an explicitly exported Bedrock-compatible endpoint key is required for a Bedrock Runtime endpoint.`,
  );
}

export function normalizeCustomAnthropicEndpointUrl(endpointUrl: string | null): string | null {
  if (!endpointUrl) return endpointUrl;
  const classification = classifyCustomAnthropicEndpoint(endpointUrl);
  return classification.kind === "bedrock-runtime" ? classification.endpointUrl : endpointUrl;
}

export function needsBedrockRuntimeAdapter(endpointUrl: string | null | undefined): boolean {
  return Boolean(endpointUrl && isBedrockRuntimeEndpoint(endpointUrl));
}

export async function selectBedrockRuntimeCustomAnthropic(
  options: {
    selectedKey: string;
    endpointUrl: string | null;
    credentialEnv: string | null;
    label: string;
    helpUrl: string | null;
    defaultModel: string;
    backToSelection: BackToSelection;
    isNonInteractive: () => boolean;
    promptInputModel: (
      label: string,
      defaultModel: string,
      validator: null,
    ) => Promise<string | BackToSelection>;
    replaceNamedCredential: (
      envName: string,
      label: string,
      helpUrl: string | null,
      validator?: ((value: string) => string | null) | null,
      revalidateSandboxIdentity?: (operation: string) => void,
    ) => Promise<string | BackToSelection>;
    credentialMutationGuard?: (operation: string) => void;
  } & BedrockRuntimeDependencies,
): Promise<
  | { action: "not-bedrock" }
  | { action: "retry-selection" }
  | { action: "selected"; model: string; preferredInferenceApi: "openai-completions" }
> {
  const { error, exitProcess } = options;
  if (options.selectedKey !== "anthropicCompatible" || !options.endpointUrl) {
    return { action: "not-bedrock" };
  }
  const classification = classifyCustomAnthropicEndpoint(options.endpointUrl);
  if (classification.kind !== "bedrock-runtime") return { action: "not-bedrock" };

  const credentialEnv = options.credentialEnv || BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV;
  if (!hasBedrockRuntimeAwsAuthEnv() && !getExplicitCompatibleCredential(credentialEnv)) {
    if (options.isNonInteractive()) {
      printMissingBedrockAuth(error);
      return exitProcess(1);
    }
    const credentialResult = await options.replaceNamedCredential(
      credentialEnv,
      `${options.label} API key`,
      options.helpUrl,
      null,
      options.credentialMutationGuard,
    );
    if (credentialResult === options.backToSelection) {
      return { action: "retry-selection" };
    }
  }

  const model = options.isNonInteractive()
    ? options.defaultModel
    : await options.promptInputModel(options.label, options.defaultModel, null);
  if (model === options.backToSelection) {
    return { action: "retry-selection" };
  }
  if (typeof model !== "string") {
    return { action: "retry-selection" };
  }
  return { action: "selected", model, preferredInferenceApi: "openai-completions" };
}

export async function setupBedrockRuntimeInference(
  options: {
    sandboxName: string | null;
    provider: string;
    model: string;
    endpointUrl: string | null;
    credentialEnv: string | null;
    isNonInteractive: () => boolean;
    gatewayName: string;
    inferenceRouteMutator: OpenShellInferenceRouteMutator;
    upsertProvider: UpsertProvider;
    verifyInferenceRoute: (provider: string, model: string) => void;
    verifyOnboardInferenceSmoke: (options: {
      provider: string;
      model: string;
      endpointUrl?: string | null;
      credentialEnv?: string | null;
      forceOpenAiLike?: boolean;
    }) => void | Promise<void>;
    ensureAdapter?: typeof ensureBedrockRuntimeAdapter;
    updateSandbox?: typeof registry.updateSandbox;
  } & BedrockRuntimeDependencies,
): Promise<{ handled: false } | { handled: true; result: SetupInferenceResult }> {
  const classification =
    options.provider === "compatible-anthropic-endpoint" && options.endpointUrl
      ? classifyCustomAnthropicEndpoint(options.endpointUrl)
      : null;
  if (classification?.kind !== "bedrock-runtime") return { handled: false };

  throw new Error(
    "Bedrock Runtime requires native sandbox provider setup. Re-run onboarding through the native inference setup owner; the shared inference route was not changed.",
  );
}
