// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HOSTED_NATIVE_PROVIDERS,
  hostedNativeProvider,
  nativeHostedAgentConfig,
} from "./inference/native-provider/agent-config.ts";
import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "./inference/anthropic/openai-surface.ts";
import {
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  isBedrockRuntimeEndpoint,
} from "./inference/bedrock-runtime.ts";
import { customNativeProviderForSelection } from "./inference/native-provider/custom.ts";
import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "./inference/native-nvidia/contract.ts";
import { NVIDIA_INFERENCE_PLACEHOLDER } from "./inference-credential.ts";
import { unsafeEndpointUrlViolation } from "./core/endpoint-url-safety.ts";
import { nativeLocalCredentialReference } from "./inference/native-local/agent-config.ts";
import { normalizeNativeProviderAttachment } from "./inference/native-provider/contract.ts";

/** Registered provider and authorized agent endpoint used by archive sanitation. */
export type HermesRegisteredRoute = Readonly<{
  provider?: string | null;
  endpointUrl?: string | null;
}>;

function hermesArchiveEndpoint(value: string): string {
  const raw = /^https?:\/\/([^/]+)(\/.*)?$/iu.exec(value);
  const url = new URL(value);
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (
    !raw ||
    unsafeEndpointUrlViolation(value) ||
    ![url.host, `${url.hostname}:${defaultPort}`].includes(raw[1]!.toLowerCase()) ||
    (raw[2] ?? "/") !== url.pathname
  )
    throw new Error("Invalid Hermes archive endpoint");
  return url.href.replace(/\/+$/u, "");
}

/** Reconcile logical registration with its validated sandbox-facing binding. */
export function hermesRegisteredRoute(
  selection: Parameters<typeof customNativeProviderForSelection>[0],
): HermesRegisteredRoute {
  const { provider, endpointUrl: logicalEndpointUrl } = selection;
  try {
    if (logicalEndpointUrl) hermesArchiveEndpoint(logicalEndpointUrl);
    const customDefinition = customNativeProviderForSelection(selection);
    const attachment = selection.nativeHostedProviderAttachment;
    let attachmentEndpoint = attachment?.endpointUrl;
    if (provider === "hermes-provider" && attachment && attachmentEndpoint === undefined) {
      const fixed = hostedNativeProvider(provider)!;
      if (!normalizeNativeProviderAttachment(attachment, fixed))
        return { provider, endpointUrl: null };
      attachmentEndpoint = fixed.endpoint;
    }
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
    let legacyAgentEndpointUrl = logicalEndpointUrl;
    if (!customDefinition && provider === "compatible-anthropic-endpoint" && logicalEndpointUrl) {
      if (!attachment && isBedrockRuntimeEndpoint(logicalEndpointUrl)) {
        legacyAgentEndpointUrl = BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL;
      } else if (!attachment || selection.preferredInferenceApi !== "anthropic-messages") {
        legacyAgentEndpointUrl = getCompatibleAnthropicOpenAiSurfaceBaseUrl(logicalEndpointUrl);
      }
    }
    // customDefinition.endpointUrl is the agent endpoint written to Hermes.
    // customDefinition.custom.endpointUrl is the logical binding: Anthropic
    // OpenAI APIs project /team to /team/v1 only in the agent endpoint.
    const agentEndpoints = (
      customDefinition
        ? [customDefinition.endpointUrl]
        : [legacyAgentEndpointUrl, attachmentEndpoint]
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
    const endpoint = hermesArchiveEndpoint(baseUrl);
    if (
      (registered !== undefined && registered.endpointUrl !== endpoint) ||
      nativeLocalCredentialReference(provider, baseUrl)
    )
      return null;
    // Reuse the writer's provider and endpoint restrictions.
    const hosted = nativeHostedAgentConfig(provider, baseUrl);
    return hosted ? { endpoint: baseUrl, template: `\${${hosted.credentialEnv}}` } : null;
  } catch {
    return null;
  }
}
