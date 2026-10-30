// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Return the OpenAI-compatible base used when a custom Anthropic endpoint is
 * routed through the managed Chat Completions frontend. Anthropic endpoint
 * normalization intentionally strips a trailing `/v1`; OpenShell's OpenAI
 * provider appends `/chat/completions`, so restore `/v1` exactly once here.
 */
export function getCompatibleAnthropicOpenAiSurfaceBaseUrl(
  endpointUrl: string | null | undefined,
): string {
  const trimmed = String(endpointUrl ?? "").replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Resolve provider-specific managed-proxy protocol requirements for an agent.
 * Hermes must use the OpenAI-compatible frontend for custom Anthropic routes
 * because the managed Anthropic SSE frontend can emit duplicate message_start
 * events (#6289). Provider setup then verifies the endpoint's OpenAI surface
 * and aligns the OpenShell provider type before the route is used.
 */
export function resolveAgentInferenceApi(
  agentName: string | null | undefined,
  provider: string | null | undefined,
  preferredInferenceApi: string | null,
): string | null {
  return agentName === "hermes" && provider === "compatible-anthropic-endpoint"
    ? "openai-completions"
    : preferredInferenceApi;
}

/**
 * OpenAI-only agents cannot consume an Anthropic Messages route. Select the
 * managed OpenAI frontend for those agents; provider setup then probes the
 * endpoint's OpenAI surface and registers the OpenShell provider as `openai`
 * before routing traffic. Provider-specific overrides for multi-protocol
 * agents such as Hermes are applied separately by resolveAgentInferenceApi().
 */
export function coerceAgentInferenceApi(
  agent: unknown,
  preferredInferenceApi: string | null,
): string | null {
  const providerType = (agent as { inference?: { provider_type?: string } } | null | undefined)
    ?.inference?.provider_type;
  if (providerType === "openai_compatible" && preferredInferenceApi === "anthropic-messages") {
    return "openai-completions";
  }
  return preferredInferenceApi;
}

/** Resolve the runtime API after applying both agent capability and provider overrides. */
export function resolveAgentProviderInferenceApi(
  agentName: string | null | undefined,
  agent: unknown,
  provider: string | null | undefined,
  preferredInferenceApi: string | null,
): string | null {
  return resolveAgentInferenceApi(
    agentName,
    provider,
    coerceAgentInferenceApi(agent, preferredInferenceApi),
  );
}
