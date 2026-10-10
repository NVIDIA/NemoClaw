// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { managedInferenceApiKey } from "./inference-credential.ts";

// The inference.local route replaces this non-secret sentinel at egress.
// Native NVIDIA routing instead expands the supervisor-issued environment handle.
export const HERMES_PROXY_REWRITE_SENTINEL = "sk-OPENSHELL-PROXY-REWRITE";

type HermesManagedProvider = {
  name: string;
  api_key: string;
  discover_models: true;
  api?: string;
  base_url?: string;
  default_model?: string;
  transport?: string;
  api_mode?: string;
};

export type HermesManagedRouting = {
  _nemoclaw_upstream: {
    provider: string;
    provider_key: string;
    model: string;
  };
  model: {
    default: string;
    provider: "custom";
    base_url: string;
    api_key: string;
    api_mode?: string;
    context_length?: number;
  };
  providers: Record<string, HermesManagedProvider>;
  custom_providers: HermesManagedProvider[];
};

export type HermesManagedRoute = {
  model: string;
  baseUrl: string;
  upstreamProvider: string;
  inferenceApi: string;
  contextWindow?: number | null;
  credentialReference?: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hermesApiMode(inferenceApi: string): string | null {
  switch (inferenceApi) {
    case "":
    case "openai-completions":
      return null;
    case "anthropic-messages":
      return "anthropic_messages";
    case "openai-responses":
      return "codex_responses";
    default:
      throw new Error(`Unsupported Hermes inference API: ${inferenceApi}`);
  }
}

export function hermesProviderKey(provider: string): string {
  const normalized = provider
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-")
    .replace(/[()]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return normalized || "nemoclaw-inference";
}

/** Apply the complete NemoClaw-owned Hermes route to an existing config. */
export function applyHermesManagedRoute(
  config: Record<string, unknown>,
  route: HermesManagedRoute,
): asserts config is Record<string, unknown> & HermesManagedRouting {
  const providerName = route.upstreamProvider || "nemoclaw-inference";
  const providerKey = hermesProviderKey(providerName);
  const apiMode = hermesApiMode(route.inferenceApi);
  const nativeCustom =
    new URL(route.baseUrl).hostname !== "inference.local" &&
    ["compatible-endpoint", "compatible-anthropic-endpoint"].includes(route.upstreamProvider);
  let apiKey = nativeCustom
    ? `sk-OPENSHELL-RESOLVE-ENV-${route.upstreamProvider === "compatible-endpoint" ? "COMPATIBLE_API_KEY" : "COMPATIBLE_ANTHROPIC_API_KEY"}`
    : managedInferenceApiKey(route.baseUrl, HERMES_PROXY_REWRITE_SENTINEL);
  if (route.credentialReference !== undefined) {
    const key =
      route.upstreamProvider === "compatible-endpoint"
        ? "COMPATIBLE_API_KEY"
        : "COMPATIBLE_ANTHROPIC_API_KEY";
    if (
      !nativeCustom ||
      !new RegExp(`^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_${key}$`, "u").test(
        route.credentialReference,
      )
    )
      throw new Error(
        "Hermes native custom inference requires its matching issued credential reference.",
      );
    apiKey =
      "sk-OPENSHELL-RESOLVE-ENV-" +
      route.credentialReference.slice("openshell:resolve:env:".length);
  }
  const previousUpstream = isObjectRecord(config._nemoclaw_upstream)
    ? config._nemoclaw_upstream
    : {};
  const previousProviderKey =
    typeof previousUpstream.provider_key === "string" ? previousUpstream.provider_key : "";

  const modelConfig: Record<string, unknown> = {
    default: route.model,
    provider: "custom",
    base_url: route.baseUrl,
    api_key: apiKey,
  };
  if (apiMode) modelConfig.api_mode = apiMode;
  if (route.contextWindow !== null && route.contextWindow !== undefined) {
    // Hermes reads context_length before endpoint discovery and model metadata.
    modelConfig.context_length = route.contextWindow;
  }

  const providerConfig: Record<string, unknown> = {
    name: providerName,
    api: route.baseUrl,
    api_key: apiKey,
    default_model: route.model,
    discover_models: true,
  };
  if (apiMode) providerConfig.transport = apiMode;

  const customProvider: Record<string, unknown> = {
    name: providerName,
    base_url: route.baseUrl,
    api_key: apiKey,
    discover_models: true,
  };
  if (apiMode) customProvider.api_mode = apiMode;

  const providers = isObjectRecord(config.providers) ? { ...config.providers } : {};
  if (previousProviderKey && previousProviderKey !== providerKey) {
    delete providers[previousProviderKey];
  }
  providers[providerKey] = providerConfig;

  const customProviders = Array.isArray(config.custom_providers)
    ? config.custom_providers.filter(
        (entry) =>
          !isObjectRecord(entry) ||
          (entry.name !== previousUpstream.provider && entry.name !== providerName),
      )
    : [];
  customProviders.push(customProvider);

  config._nemoclaw_upstream = {
    provider: providerName,
    provider_key: providerKey,
    model: route.model,
  };
  config.model = modelConfig;
  config.providers = providers;
  config.custom_providers = customProviders;
}
