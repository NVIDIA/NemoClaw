// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const COMPATIBLE_INFERENCE_FLAG = "NEMOCLAW_E2E_USE_NVIDIA_SECRET_AS_COMPATIBLE";
const DEFAULT_COMPATIBLE_BASE_URL = "https://inference-api.nvidia.com/v1";
const DEFAULT_COMPATIBLE_MODEL = "nvidia/nvidia/nemotron-3-super-v3";

export interface HostedInferenceSecrets {
  optional(name: string): string | undefined;
  required(name: string): string;
}

export interface HostedInferenceOptions {
  nvidiaSecretName?: "NVIDIA_INFERENCE_API_KEY" | "NVIDIA_API_KEY";
  nvidiaModel?: string;
}

export interface HostedInferenceConfig {
  apiKey: string;
  credentialEnv: "NVIDIA_INFERENCE_API_KEY" | "NVIDIA_API_KEY" | "COMPATIBLE_API_KEY";
  provider: "nvidia" | "compatible";
  providerName: "nvidia-prod" | "compatible-endpoint";
  env: NodeJS.ProcessEnv;
  model: string;
  endpointUrl: string;
  contractLabel: string;
}

export function usingCiCompatibleInference(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COMPATIBLE_INFERENCE_FLAG] === "1";
}

export function requireHostedInferenceConfig(
  secrets: HostedInferenceSecrets,
  env: NodeJS.ProcessEnv = process.env,
  options: HostedInferenceOptions = {},
): HostedInferenceConfig {
  const nvidiaSecretName = options.nvidiaSecretName ?? "NVIDIA_INFERENCE_API_KEY";

  if (usingCiCompatibleInference(env)) {
    const apiKey =
      secrets.optional("COMPATIBLE_API_KEY") ??
      secrets.optional("NVIDIA_INFERENCE_API_KEY") ??
      secrets.required(nvidiaSecretName);
    const endpointUrl = env.NEMOCLAW_ENDPOINT_URL || DEFAULT_COMPATIBLE_BASE_URL;
    const model = env.NEMOCLAW_MODEL || env.NEMOCLAW_COMPAT_MODEL || DEFAULT_COMPATIBLE_MODEL;
    return {
      apiKey,
      credentialEnv: "COMPATIBLE_API_KEY",
      provider: "compatible",
      providerName: "compatible-endpoint",
      endpointUrl,
      model,
      env: {
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_ENDPOINT_URL: endpointUrl,
        NEMOCLAW_MODEL: model,
        NEMOCLAW_COMPAT_MODEL: model,
        COMPATIBLE_API_KEY: apiKey,
      },
      contractLabel: "CI compatible inference credential is present",
    };
  }

  const apiKey = secrets.required(nvidiaSecretName);
  if (!apiKey.startsWith("nvapi-")) {
    throw new Error(
      `${nvidiaSecretName} must start with nvapi- unless ${COMPATIBLE_INFERENCE_FLAG}=1 is set`,
    );
  }

  const model = options.nvidiaModel ?? env.NEMOCLAW_MODEL ?? "";
  return {
    apiKey,
    credentialEnv: nvidiaSecretName,
    provider: "nvidia",
    providerName: "nvidia-prod",
    endpointUrl: DEFAULT_COMPATIBLE_BASE_URL,
    model,
    env: {
      [nvidiaSecretName]: apiKey,
      ...(model ? { NEMOCLAW_MODEL: model } : {}),
    },
    contractLabel: `${nvidiaSecretName} is present and nvapi-prefixed`,
  };
}
