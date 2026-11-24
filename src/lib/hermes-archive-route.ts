// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HOSTED_NATIVE_PROVIDERS,
  nativeHostedAgentConfig,
} from "./inference/native-provider/agent-config.ts";
import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "./inference/anthropic/openai-surface.ts";
import { customNativeProviderForSelection } from "./inference/native-provider/custom.ts";
import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "./inference/native-nvidia/contract.ts";
import { NVIDIA_INFERENCE_PLACEHOLDER } from "./inference-credential.ts";

/** Registered provider and authorized agent endpoint used by archive sanitation. */
export type HermesRegisteredRoute = Readonly<{
  provider?: string | null;
  endpointUrl?: string | null;
}>;

function hermesArchiveEndpoint(value: string): string {
  // URL serialization normalizes host spelling and default ports, while retaining
  // the API path, credentials, query and fragment for the writer's validation.
  return new URL(value).href.replace(/\/+$/u, "");
}

/** Reconcile logical registration with its validated sandbox-facing binding. */
export function hermesRegisteredRoute(
  selection: Parameters<typeof customNativeProviderForSelection>[0],
): HermesRegisteredRoute {
  const { provider, endpointUrl: logicalEndpointUrl } = selection;
  try {
    const customDefinition = customNativeProviderForSelection(selection);
    const attachment = selection.nativeHostedProviderAttachment;
    // The binding owner checks the logical endpoint, API and credential name,
    // then supplies the agent projection (for example /team -> /team/v1).
    if (
      customDefinition &&
      logicalEndpointUrl &&
      !nativeHostedAgentConfig(provider, logicalEndpointUrl)
    )
      return { provider, endpointUrl: null };
    // Legacy selections have no custom binding. Compare their logical endpoint
    // through the same API projection that writes the agent configuration.
    const legacyAgentEndpointUrl =
      provider === "compatible-anthropic-endpoint" &&
      logicalEndpointUrl &&
      selection.preferredInferenceApi &&
      selection.preferredInferenceApi !== "anthropic-messages"
        ? getCompatibleAnthropicOpenAiSurfaceBaseUrl(logicalEndpointUrl)
        : logicalEndpointUrl;
    // customDefinition.endpointUrl is the agent endpoint written to Hermes.
    // customDefinition.custom.endpointUrl is the logical binding: Anthropic
    // OpenAI APIs project /team to /team/v1 only in the agent endpoint.
    const agentEndpoints = (
      customDefinition
        ? [customDefinition.endpointUrl]
        : [legacyAgentEndpointUrl, attachment?.endpointUrl]
    )
      .filter((endpoint): endpoint is string => endpoint !== null && endpoint !== undefined)
      .map(hermesArchiveEndpoint);
    const agentEndpointUrl = agentEndpoints[0];
    return {
      provider,
      endpointUrl:
        agentEndpointUrl && agentEndpoints.every((endpoint) => endpoint === agentEndpointUrl)
          ? agentEndpointUrl
          : null,
    };
  } catch {
    return { provider, endpointUrl: null };
  }
}

/**
 * Resolve the endpoint and environment reference NemoClaw generates for a route.
 *
 * A fixed provider has one canonical endpoint, so its reference cannot point at
 * a different destination. A custom endpoint, or the endpoint an authenticated
 * Hermes Provider login returned, is chosen outside NemoClaw, so the archived
 * route must match the authorized agent endpoint. When `registered` is given, the
 * archived provider must also be the registered one. Pass it when sanitizing an
 * archive. Omit it only to inspect an archive whose routes sanitation already
 * verified.
 */
export function hermesManagedRouteReference(
  provider: string,
  baseUrl: unknown,
  registered?: HermesRegisteredRoute,
): { endpoint: string; template: string } | null {
  if (registered !== undefined && registered.provider !== provider) return null;
  if (provider === "nvidia-prod") {
    return { endpoint: NVIDIA_HOSTED_NATIVE_ENDPOINT, template: NVIDIA_INFERENCE_PLACEHOLDER };
  }
  const fixed = HOSTED_NATIVE_PROVIDERS.find((entry) => entry.logicalProvider === provider);
  if (fixed && provider !== "hermes-provider") {
    return { endpoint: fixed.endpoint, template: `\${${fixed.credentialEnv}}` };
  }
  if (typeof baseUrl !== "string") return null;
  try {
    if (registered !== undefined && registered.endpointUrl !== hermesArchiveEndpoint(baseUrl))
      return null;
    // Reuse the writer's provider and endpoint restrictions.
    const hosted = nativeHostedAgentConfig(provider, baseUrl);
    return hosted ? { endpoint: baseUrl, template: `\${${hosted.credentialEnv}}` } : null;
  } catch {
    return null;
  }
}
