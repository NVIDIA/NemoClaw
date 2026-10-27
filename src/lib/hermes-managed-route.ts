// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { nativeHostedAgentConfig } from "./inference/native-provider/agent-config.ts";
import {
  nativeLocalCredentialReference,
  NATIVE_LOCAL_CREDENTIAL_ENV,
  NATIVE_LOCAL_RUNTIME_REFERENCE_PATTERN,
} from "./inference/native-local/agent-config.ts";
import {
  NATIVE_NVIDIA_SCOPED_HANDLE_PATTERN,
  managedInferenceApiKey,
  NVIDIA_INFERENCE_PLACEHOLDER,
} from "./inference-credential.ts";

// Shared inference routing replaces this sentinel at egress. Native NVIDIA
// routing instead expands the supervisor-issued environment handle.
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
  nativeCredentialHandle?: string;
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
  const nativeHosted = nativeHostedAgentConfig(route.upstreamProvider, route.baseUrl);
  const nativeLocal = nativeLocalCredentialReference(route.upstreamProvider, route.baseUrl);
  let apiKey = nativeLocal
    ? `\${${NATIVE_LOCAL_CREDENTIAL_ENV}}`
    : nativeHosted
      ? `\${${nativeHosted.credentialEnv}}`
      : managedInferenceApiKey(route.baseUrl, HERMES_PROXY_REWRITE_SENTINEL);
  if (route.nativeCredentialHandle !== undefined) {
    if (nativeLocal) {
      const match = new RegExp(NATIVE_LOCAL_RUNTIME_REFERENCE_PATTERN).exec(
        route.nativeCredentialHandle,
      );
      // Require the entire value: JavaScript's `$` also matches before a final newline.
      if (!match || match[0] !== route.nativeCredentialHandle) {
        throw new Error("Hermes native local route requires a provider-bound credential handle.");
      }
    } else if (
      route.upstreamProvider !== "nvidia-prod" ||
      apiKey !== NVIDIA_INFERENCE_PLACEHOLDER ||
      !NATIVE_NVIDIA_SCOPED_HANDLE_PATTERN.test(route.nativeCredentialHandle)
    ) {
      throw new Error("Hermes native NVIDIA route requires a provider-bound credential handle.");
    }
    apiKey = route.nativeCredentialHandle;
  }
  const providerName = route.upstreamProvider || "nemoclaw-inference";
  const providerKey = hermesProviderKey(providerName);
  const apiMode = hermesApiMode(route.inferenceApi);
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
    ...(nativeHosted?.headers ? { default_headers: nativeHosted.headers } : {}),
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
    ...(nativeHosted?.headers ? { default_headers: nativeHosted.headers } : {}),
    default_model: route.model,
    discover_models: true,
  };
  if (apiMode) providerConfig.transport = apiMode;

  const customProvider: Record<string, unknown> = {
    name: providerName,
    base_url: route.baseUrl,
    api_key: apiKey,
    ...(nativeHosted?.headers ? { default_headers: nativeHosted.headers } : {}),
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

/** Refresh an issued managed reference without replacing restored model settings. */
export function refreshHermesNativeLocalCredential(
  config: Record<string, unknown>,
  route: HermesManagedRoute & { nativeCredentialHandle: string },
): void {
  const expected: Record<string, unknown> = {};
  applyHermesManagedRoute(expected, route);
  const upstream = isObjectRecord(config._nemoclaw_upstream) ? config._nemoclaw_upstream : {};
  const model = isObjectRecord(config.model) ? config.model : {};
  const providers = isObjectRecord(config.providers) ? config.providers : {};
  const providerKey = hermesProviderKey(route.upstreamProvider);
  const managed = isObjectRecord(providers[providerKey]) ? providers[providerKey] : {};
  const custom = Array.isArray(config.custom_providers) ? config.custom_providers : [];
  const matches = custom.filter(
    (entry) => isObjectRecord(entry) && entry.name === route.upstreamProvider,
  );
  const previous = model.api_key;
  const nvidia =
    route.upstreamProvider === "nvidia-prod" &&
    managedInferenceApiKey(route.baseUrl, "") === NVIDIA_INFERENCE_PLACEHOLDER;
  const pattern = nvidia
    ? NATIVE_NVIDIA_SCOPED_HANDLE_PATTERN
    : new RegExp(NATIVE_LOCAL_RUNTIME_REFERENCE_PATTERN);
  const template = nvidia ? NVIDIA_INFERENCE_PLACEHOLDER : `\${${NATIVE_LOCAL_CREDENTIAL_ENV}}`;
  const reference = pattern.exec(String(previous));
  if (
    (!nvidia && !nativeLocalCredentialReference(route.upstreamProvider, route.baseUrl)) ||
    upstream.provider !== route.upstreamProvider ||
    upstream.provider_key !== providerKey ||
    upstream.model !== route.model ||
    model.default !== route.model ||
    model.provider !== "custom" ||
    model.base_url !== route.baseUrl ||
    (model.api_mode ?? null) !== (expected.model.api_mode ?? null) ||
    managed.api !== route.baseUrl ||
    managed.default_model !== route.model ||
    (managed.transport ?? null) !== (expected.providers[providerKey].transport ?? null) ||
    matches.length !== 1 ||
    matches[0].base_url !== route.baseUrl ||
    (matches[0].api_mode ?? null) !== (expected.custom_providers[0].api_mode ?? null) ||
    typeof previous !== "string" ||
    managed.api_key !== previous ||
    matches[0].api_key !== previous ||
    (previous !== template && reference?.[0] !== previous)
  ) {
    throw new Error("Restored Hermes inference configuration does not match its registered route.");
  }
  // YAML aliases may share these maps with user settings: replace only owned
  // credential slots, while retaining the config object's guarded-read digest.
  config.model = { ...model, api_key: route.nativeCredentialHandle };
  config.providers = {
    ...providers,
    [providerKey]: { ...managed, api_key: route.nativeCredentialHandle },
  };
  config.custom_providers = custom.map((entry) =>
    entry === matches[0] ? { ...entry, api_key: route.nativeCredentialHandle } : entry,
  );
}
