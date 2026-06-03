// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compactText } from "../core/url-utils";
import {
  BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV,
  BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV,
  classifyCustomAnthropicEndpoint,
  hasBedrockRuntimeAwsAuthEnv,
  isBedrockRuntimeEndpoint,
} from "../inference/bedrock-runtime";
import { ensureBedrockRuntimeAdapter } from "../inference/bedrock-runtime-adapter";
import type { BackToSelection } from "../navigation";
import { redact } from "../runner";
import * as registry from "../state/registry";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "./env";

type RunOpenshell = (
  args: string[],
  options?: { ignoreError?: boolean; suppressOutput?: boolean; timeout?: number },
) => { status: number | null; stdout?: unknown; stderr?: unknown };

type UpsertProvider = (
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
  env?: NodeJS.ProcessEnv,
) => { ok: boolean; message?: string; status?: number };

type SetupInferenceResult = { ok: true; retry?: undefined } | { retry: "selection" };

function normalizeCredentialValue(value: unknown): string {
  return String(value ?? "").trim();
}

function getExplicitCompatibleCredential(credentialEnv: string | null | undefined): string | null {
  if (!credentialEnv) return null;
  return normalizeCredentialValue(process.env[credentialEnv]) || null;
}

function printMissingBedrockAuth(): void {
  console.error(
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

export async function selectBedrockRuntimeCustomAnthropic(options: {
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
  ) => Promise<string | BackToSelection>;
}): Promise<
  | { action: "not-bedrock" }
  | { action: "retry-selection" }
  | { action: "selected"; model: string; preferredInferenceApi: "openai-completions" }
> {
  if (options.selectedKey !== "anthropicCompatible" || !options.endpointUrl) {
    return { action: "not-bedrock" };
  }
  const classification = classifyCustomAnthropicEndpoint(options.endpointUrl);
  if (classification.kind !== "bedrock-runtime") return { action: "not-bedrock" };

  const credentialEnv = options.credentialEnv || BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV;
  if (!hasBedrockRuntimeAwsAuthEnv() && !getExplicitCompatibleCredential(credentialEnv)) {
    if (options.isNonInteractive()) {
      printMissingBedrockAuth();
      process.exit(1);
    }
    const credentialResult = await options.replaceNamedCredential(
      credentialEnv,
      `${options.label} API key`,
      options.helpUrl,
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

export async function setupBedrockRuntimeInference(options: {
  sandboxName: string | null;
  provider: string;
  model: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  isNonInteractive: () => boolean;
  runOpenshell: RunOpenshell;
  upsertProvider: UpsertProvider;
  verifyInferenceRoute: (provider: string, model: string) => void;
  verifyOnboardInferenceSmoke: (options: {
    provider: string;
    model: string;
    endpointUrl?: string | null;
    credentialEnv?: string | null;
    forceOpenAiLike?: boolean;
  }) => void;
}): Promise<{ handled: false } | { handled: true; result: SetupInferenceResult }> {
  const classification =
    options.provider === "compatible-anthropic-endpoint" && options.endpointUrl
      ? classifyCustomAnthropicEndpoint(options.endpointUrl)
      : null;
  if (classification?.kind !== "bedrock-runtime") return { handled: false };

  const credentialEnv = options.credentialEnv || BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV;
  const compatibleCredential = getExplicitCompatibleCredential(credentialEnv);
  if (!hasBedrockRuntimeAwsAuthEnv() && !compatibleCredential) {
    printMissingBedrockAuth();
    if (options.isNonInteractive()) process.exit(1);
    return { handled: true, result: { retry: "selection" } };
  }

  let adapter: Awaited<ReturnType<typeof ensureBedrockRuntimeAdapter>>;
  try {
    adapter = await ensureBedrockRuntimeAdapter({ classification, compatibleCredential });
  } catch (err) {
    console.error(
      `  Failed to start Bedrock Runtime adapter: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (options.isNonInteractive()) process.exit(1);
    return { handled: true, result: { retry: "selection" } };
  }

  const providerResult = options.upsertProvider(
    options.provider,
    "openai",
    adapter.credentialEnv,
    adapter.baseUrl,
    { [adapter.credentialEnv]: adapter.token },
  );
  if (!providerResult.ok) {
    console.error(`  ${providerResult.message}`);
    if (options.isNonInteractive()) process.exit(providerResult.status || 1);
    return { handled: true, result: { retry: "selection" } };
  }
  console.log(
    `  Bedrock Runtime adapter ready: region ${adapter.region}, sandbox route ${adapter.baseUrl}, host log ${adapter.logPath}`,
  );

  const applyResult = options.runOpenshell(
    [
      "inference",
      "set",
      "--no-verify",
      "--provider",
      options.provider,
      "--model",
      options.model,
      "--timeout",
      String(LOCAL_INFERENCE_TIMEOUT_SECS),
    ],
    { ignoreError: true },
  );
  if (applyResult.status !== 0) {
    const message =
      compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
      `Failed to configure inference provider '${options.provider}'.`;
    console.error(`  ${message}`);
    if (options.isNonInteractive()) process.exit(applyResult.status || 1);
    return { handled: true, result: { retry: "selection" } };
  }

  options.verifyInferenceRoute(options.provider, options.model);
  options.verifyOnboardInferenceSmoke({
    provider: options.provider,
    model: options.model,
    endpointUrl: adapter.localBaseUrl,
    credentialEnv: adapter.credentialEnv,
    forceOpenAiLike: true,
  });
  if (options.sandboxName) {
    registry.updateSandbox(options.sandboxName, {
      model: options.model,
      provider: options.provider,
    });
  }
  console.log(`  ✓ Inference route set: ${options.provider} / ${options.model}`);
  return { handled: true, result: { ok: true } };
}
