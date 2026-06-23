// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HOSTED_INFERENCE_SECRET = "NVIDIA_INFERENCE_API_KEY";
const HOSTED_INFERENCE_PUBLIC_FALLBACK_SECRET = "NVIDIA_API_KEY";
const HOSTED_INFERENCE_CREDENTIAL_ENV = "COMPATIBLE_API_KEY";
const HOSTED_INFERENCE_PROVIDER = "custom";
const HOSTED_INFERENCE_PROVIDER_NAME = "compatible-endpoint";
const DEFAULT_HOSTED_INFERENCE_BASE_URL = "https://inference-api.nvidia.com/v1";
const DEFAULT_HOSTED_INFERENCE_MODEL = "nvidia/nvidia/nemotron-3-super-v3";

export interface HostedInferenceSecrets {
  optional?(name: string): string | undefined;
  required(name: string): string;
}

export interface HostedInferenceOptions {
  model?: string;
  preferredApi?: string;
}

export interface HostedInferenceConfig {
  apiKey: string;
  sourceSecretName: typeof HOSTED_INFERENCE_SECRET | typeof HOSTED_INFERENCE_PUBLIC_FALLBACK_SECRET;
  credentialEnv: typeof HOSTED_INFERENCE_CREDENTIAL_ENV;
  provider: typeof HOSTED_INFERENCE_PROVIDER;
  providerName: typeof HOSTED_INFERENCE_PROVIDER_NAME;
  env: NodeJS.ProcessEnv;
  model: string;
  endpointUrl: string;
  contractLabel: string;
}

export function requireHostedInferenceConfig(
  secrets: HostedInferenceSecrets,
  env: NodeJS.ProcessEnv = process.env,
  options: HostedInferenceOptions = {},
): HostedInferenceConfig {
  const canonicalApiKey = secrets.required(HOSTED_INFERENCE_SECRET);
  const publicFallbackApiKey = secrets.optional?.(HOSTED_INFERENCE_PUBLIC_FALLBACK_SECRET);
  const hostedPublicFallbackApiKey = publicFallbackApiKey?.startsWith("nvapi-")
    ? publicFallbackApiKey
    : undefined;
  const apiKey = canonicalApiKey.startsWith("nvapi-")
    ? canonicalApiKey
    : hostedPublicFallbackApiKey || canonicalApiKey;
  const sourceSecretName = canonicalApiKey.startsWith("nvapi-")
    ? HOSTED_INFERENCE_SECRET
    : hostedPublicFallbackApiKey
      ? HOSTED_INFERENCE_PUBLIC_FALLBACK_SECRET
      : HOSTED_INFERENCE_SECRET;
  const endpointUrl = env.NEMOCLAW_ENDPOINT_URL || DEFAULT_HOSTED_INFERENCE_BASE_URL;
  const model =
    env.NEMOCLAW_MODEL ||
    env.NEMOCLAW_COMPAT_MODEL ||
    options.model ||
    DEFAULT_HOSTED_INFERENCE_MODEL;
  const preferredApi = options.preferredApi || env.NEMOCLAW_PREFERRED_API || "openai-completions";
  return {
    apiKey,
    sourceSecretName,
    credentialEnv: HOSTED_INFERENCE_CREDENTIAL_ENV,
    provider: HOSTED_INFERENCE_PROVIDER,
    providerName: HOSTED_INFERENCE_PROVIDER_NAME,
    endpointUrl,
    model,
    env: {
      NEMOCLAW_PROVIDER: HOSTED_INFERENCE_PROVIDER,
      NEMOCLAW_ENDPOINT_URL: endpointUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_COMPAT_MODEL: model,
      NEMOCLAW_PREFERRED_API: preferredApi,
      [HOSTED_INFERENCE_CREDENTIAL_ENV]: apiKey,
    },
    contractLabel: "NVIDIA_INFERENCE_API_KEY is staged as the compatible endpoint credential",
  };
}
