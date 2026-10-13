// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { type NativeProviderAttachment, type NativeProviderDefinition } from "./contract.ts";

export type HostedProviderDefinition = NativeProviderDefinition &
  Readonly<{
    endpoint: string;
    api: "openai-completions" | "anthropic-messages";
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

/** Only the authenticated Hermes provider may bind a returned endpoint. */
export function canonicalHermesNativeEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.hostname === "inference.local" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname.endsWith(".internal") ||
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    /[\\\s]/u.test(value) ||
    /%2f|%5c/iu.test(endpoint.pathname)
  ) {
    throw new Error(
      "Hermes inference requires an HTTPS endpoint without credentials, query, fragment, or encoded separators",
    );
  }
  return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
}

export function hostedNativeProvider(
  provider: string | null | undefined,
  endpointUrl?: string | null,
): HostedProviderDefinition | undefined {
  const definition = HOSTED_NATIVE_PROVIDERS.find(
    (entry) => entry.logicalProvider === provider?.trim(),
  );
  if (!definition || definition.logicalProvider !== "hermes-provider" || !endpointUrl)
    return definition;
  const endpoint = canonicalHermesNativeEndpoint(endpointUrl);
  if (endpoint === definition.endpoint) return definition;
  const suffix = createHash("sha256").update(endpoint).digest("hex").slice(0, 20);
  return {
    ...definition,
    endpoint,
    endpointUrl: endpoint,
    profileId: `nemoclaw-hermes-inference-${suffix}-v1`,
    providerName: `nemoclaw-hermes-${suffix}-v1`,
  };
}

/** Keep explicit user-supplied Hermes endpoints on their existing workflow. */
export function usesNativeHermesEndpoint(
  endpoint: string | null | undefined,
  authority?: NativeProviderAttachment,
): boolean {
  const fixed = hostedNativeProvider("hermes-provider")!;
  const normalized = endpoint?.replace(/\/+$/, "");
  return !normalized || normalized === fixed.endpoint || normalized === authority?.endpointUrl;
}
