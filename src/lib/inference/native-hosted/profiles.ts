// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface NativeHostedProfile {
  readonly label: string;
  readonly logicalProvider: string;
  readonly profileId: string;
  readonly providerName: string;
  readonly endpoint: string;
  readonly credentialEnv:
    | "NVIDIA_INFERENCE_API_KEY"
    | "OPENAI_API_KEY"
    | "ANTHROPIC_API_KEY"
    | "GEMINI_API_KEY"
    | "OPENROUTER_API_KEY";
}

export const NATIVE_HOSTED_PROFILES: readonly NativeHostedProfile[] = [
  {
    label: "NVIDIA",
    logicalProvider: "nvidia-prod",
    profileId: "nemoclaw-nvidia-inference-v1",
    providerName: "nemoclaw-nvidia-prod-v1",
    endpoint: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  },
  {
    label: "OpenAI",
    logicalProvider: "openai-api",
    profileId: "nemoclaw-openai-inference-v1",
    providerName: "nemoclaw-openai-api-v1",
    endpoint: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
  },
  {
    label: "Anthropic",
    logicalProvider: "anthropic-prod",
    profileId: "nemoclaw-anthropic-inference-v1",
    providerName: "nemoclaw-anthropic-prod-v1",
    endpoint: "https://api.anthropic.com",
    credentialEnv: "ANTHROPIC_API_KEY",
  },
  {
    label: "Google Gemini",
    logicalProvider: "gemini-api",
    profileId: "nemoclaw-gemini-inference-v1",
    providerName: "nemoclaw-gemini-api-v1",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    credentialEnv: "GEMINI_API_KEY",
  },
  {
    label: "OpenRouter",
    logicalProvider: "openrouter-api",
    profileId: "nemoclaw-openrouter-inference-v1",
    providerName: "nemoclaw-openrouter-api-v1",
    endpoint: "https://openrouter.ai/api/v1",
    credentialEnv: "OPENROUTER_API_KEY",
  },
  {
    label: "Hermes Provider",
    logicalProvider: "hermes-provider",
    profileId: "nemoclaw-hermes-inference-v1",
    providerName: "nemoclaw-hermes-provider-v1",
    endpoint: "https://inference-api.nousresearch.com/v1",
    credentialEnv: "OPENAI_API_KEY",
  },
];

export function nativeHostedProfile(
  provider: string | null | undefined,
): NativeHostedProfile | undefined {
  const name = provider?.trim();
  return NATIVE_HOSTED_PROFILES.find((profile) => profile.logicalProvider === name);
}
