// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety.ts";
import type { NativeProviderDefinition } from "./contract.ts";

export function isCustomHostedProvider(provider: string | null | undefined): boolean {
  return provider === "compatible-endpoint" || provider === "compatible-anthropic-endpoint";
}

/** Resolve the native binding and agent configuration from the same API selection. */
export function resolveCustomNativeApi(
  provider: string | null | undefined,
  preferredApi: string | null | undefined,
  nativeProvider: boolean,
): string | null {
  if (!nativeProvider || !isCustomHostedProvider(provider)) return preferredApi ?? null;
  return (
    preferredApi ||
    (provider === "compatible-anthropic-endpoint" ? "anthropic-messages" : "openai-completions")
  );
}

export function customNativeCredentialEnv(provider: string): string {
  if (provider === "compatible-endpoint") return "COMPATIBLE_API_KEY";
  if (provider === "compatible-anthropic-endpoint") return "COMPATIBLE_ANTHROPIC_API_KEY";
  throw new Error("Unsupported custom hosted provider");
}

export type HostedProviderDefinition = NativeProviderDefinition &
  Readonly<{
    endpoint: string;
    api: "openai-completions" | "openai-responses" | "anthropic-messages";
  }>;

/** Existing fixed hosted selections only; custom and local endpoints have separate owners. */
export const HOSTED_NATIVE_PROVIDERS = [
  {
    logicalProvider: "openai-api",
    label: "OpenAI",
    profileId: "nemoclaw-openai-inference-v1",
    providerName: "nemoclaw-openai-api-v1",
    credentialEnv: "OPENAI_API_KEY",
    endpoint: "https://api.openai.com/v1",
    api: "openai-completions",
  },
  {
    logicalProvider: "anthropic-prod",
    label: "Anthropic",
    profileId: "nemoclaw-anthropic-inference-v1",
    providerName: "nemoclaw-anthropic-prod-v1",
    credentialEnv: "ANTHROPIC_API_KEY",
    endpoint: "https://api.anthropic.com",
    api: "anthropic-messages",
  },
  {
    logicalProvider: "gemini-api",
    label: "Gemini",
    profileId: "nemoclaw-gemini-inference-v1",
    providerName: "nemoclaw-gemini-api-v1",
    credentialEnv: "GEMINI_API_KEY",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/",
    api: "openai-completions",
  },
  {
    logicalProvider: "openrouter-api",
    label: "OpenRouter",
    profileId: "nemoclaw-openrouter-inference-v1",
    providerName: "nemoclaw-openrouter-api-v1",
    credentialEnv: "OPENROUTER_API_KEY",
    endpoint: "https://openrouter.ai/api/v1",
    api: "openai-completions",
  },
  {
    logicalProvider: "hermes-provider",
    label: "Hermes Provider",
    profileId: "nemoclaw-hermes-inference-v1",
    providerName: "nemoclaw-hermes-provider-v1",
    credentialEnv: "OPENAI_API_KEY",
    endpoint: "https://inference-api.nousresearch.com/v1",
    api: "openai-completions",
  },
] as const satisfies readonly HostedProviderDefinition[];

/** Parse public image configuration; host admission separately checks private destinations. */
export function recordedHermesEndpointUrl(value: string): URL {
  const endpoint = new URL(value);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    unsafeEndpointUrlViolation(value) ||
    /%2f|%5c/iu.test(endpoint.pathname)
  )
    throw new Error("Recorded Hermes inference endpoint is not an admitted HTTP(S) destination");
  return endpoint;
}

export function fixedHostedNativeProvider(
  provider: string | null | undefined,
): HostedProviderDefinition | undefined {
  return HOSTED_NATIVE_PROVIDERS.find((entry) => entry.logicalProvider === provider?.trim());
}
