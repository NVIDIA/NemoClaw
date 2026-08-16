// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HOSTED_INFERENCE_SECRET = "NVIDIA_INFERENCE_API_KEY";
export const HOSTED_INFERENCE_CREDENTIAL_ENV = "COMPATIBLE_API_KEY";
export const HOSTED_INFERENCE_MODELS_PROBE_SECRET_ENV = HOSTED_INFERENCE_SECRET;
export const HOSTED_INFERENCE_PROVIDER = "custom";
export const HOSTED_INFERENCE_PROVIDER_NAME = "compatible-endpoint";
export const DEFAULT_HOSTED_INFERENCE_BASE_URL = "https://inference-api.nvidia.com/v1";
export const DEFAULT_HOSTED_INFERENCE_MODEL = "nvidia/nvidia/nemotron-3-ultra";

export interface HostedInferenceSecrets {
  required(name: string): string;
}

export interface HostedInferenceOptions {
  model?: string;
}

export interface HostedInferenceConfig {
  apiKey: string;
  sourceSecretName: typeof HOSTED_INFERENCE_SECRET;
  credentialEnv: typeof HOSTED_INFERENCE_CREDENTIAL_ENV;
  provider: typeof HOSTED_INFERENCE_PROVIDER;
  providerName: typeof HOSTED_INFERENCE_PROVIDER_NAME;
  env: NodeJS.ProcessEnv;
  model: string;
  endpointUrl: string;
  contractLabel: string;
}

export interface HostedInferenceModelsProbe {
  args: string[];
  command: "bash";
  env: NodeJS.ProcessEnv;
}

export function buildHostedInferenceModelsProbe(
  apiKey: string,
  endpointUrl: string,
): HostedInferenceModelsProbe {
  if (!apiKey || /[\r\n]/u.test(apiKey)) {
    throw new Error("hosted inference API key must be nonempty and single-line");
  }
  const baseUrl = endpointUrl.endsWith("/") ? endpointUrl : `${endpointUrl}/`;
  const modelsUrl = new URL("models", baseUrl).toString();
  return {
    command: "bash",
    args: [
      "-c",
      `set -euo pipefail; printf 'Authorization: Bearer %s\\n' "$${HOSTED_INFERENCE_MODELS_PROBE_SECRET_ENV}" | curl -fsS --max-time 60 --header @- "$1"`,
      "hosted-inference-models-probe",
      modelsUrl,
    ],
    env: { [HOSTED_INFERENCE_MODELS_PROBE_SECRET_ENV]: apiKey },
  };
}

export function requireHostedInferenceConfig(
  secrets: HostedInferenceSecrets,
  env: NodeJS.ProcessEnv = process.env,
  options: HostedInferenceOptions = {},
): HostedInferenceConfig {
  const apiKey = secrets.required(HOSTED_INFERENCE_SECRET);
  const endpointUrl = env.NEMOCLAW_ENDPOINT_URL || DEFAULT_HOSTED_INFERENCE_BASE_URL;
  const model =
    env.NEMOCLAW_MODEL ||
    env.NEMOCLAW_COMPAT_MODEL ||
    options.model ||
    DEFAULT_HOSTED_INFERENCE_MODEL;
  return {
    apiKey,
    sourceSecretName: HOSTED_INFERENCE_SECRET,
    credentialEnv: HOSTED_INFERENCE_CREDENTIAL_ENV,
    provider: HOSTED_INFERENCE_PROVIDER,
    providerName: HOSTED_INFERENCE_PROVIDER_NAME,
    endpointUrl,
    model,
    env: {
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NEMOCLAW_PROVIDER: HOSTED_INFERENCE_PROVIDER,
      NEMOCLAW_ENDPOINT_URL: endpointUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_COMPAT_MODEL: model,
      NEMOCLAW_PREFERRED_API: env.NEMOCLAW_PREFERRED_API || "openai-completions",
      [HOSTED_INFERENCE_SECRET]: apiKey,
      [HOSTED_INFERENCE_CREDENTIAL_ENV]: apiKey,
    },
    contractLabel: "NVIDIA_INFERENCE_API_KEY is staged as the compatible endpoint credential",
  };
}
