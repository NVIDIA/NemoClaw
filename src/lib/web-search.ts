// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type WebSearchProvider = "brave" | "gemini" | "tavily";

export interface WebSearchConfig {
  provider: WebSearchProvider;
  fetchEnabled: boolean;
}

export interface DisabledWebSearchConfig {
  provider?: WebSearchProvider;
  fetchEnabled: false;
}

export type PersistedWebSearchConfig = WebSearchConfig | DisabledWebSearchConfig;

export interface WebSearchProviderMetadata {
  provider: WebSearchProvider;
  label: string;
  helpUrl: string;
  credentialEnv: string;
  pluginEntry: string;
  policyPreset: string;
}

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
export const WEB_SEARCH_PROVIDER_ENV = "NEMOCLAW_WEB_SEARCH_PROVIDER";
export const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-2.5-flash";

const WEB_SEARCH_PROVIDERS: Record<WebSearchProvider, WebSearchProviderMetadata> = {
  brave: {
    provider: "brave",
    label: "Brave Search",
    helpUrl: "https://api.search.brave.com/app/keys",
    credentialEnv: BRAVE_API_KEY_ENV,
    pluginEntry: "brave",
    policyPreset: "brave",
  },
  gemini: {
    provider: "gemini",
    label: "Google Gemini",
    helpUrl: "https://aistudio.google.com/app/apikey",
    credentialEnv: GEMINI_API_KEY_ENV,
    pluginEntry: "google",
    policyPreset: "gemini",
  },
  tavily: {
    provider: "tavily",
    label: "Tavily",
    helpUrl: "https://app.tavily.com",
    credentialEnv: TAVILY_API_KEY_ENV,
    pluginEntry: "tavily",
    policyPreset: "tavily",
  },
};

export function encodeDockerJsonArg(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8").toString("base64");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function listWebSearchProviders(): WebSearchProviderMetadata[] {
  return Object.values(WEB_SEARCH_PROVIDERS);
}

export function parseWebSearchProvider(value: unknown): WebSearchProvider | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return Object.hasOwn(WEB_SEARCH_PROVIDERS, normalized)
    ? (normalized as WebSearchProvider)
    : null;
}

export function getWebSearchProvider(provider: WebSearchProvider): WebSearchProviderMetadata {
  return WEB_SEARCH_PROVIDERS[provider];
}

export function normalizePersistedWebSearchConfig(
  value: unknown,
): PersistedWebSearchConfig | null {
  if (!isObject(value) || typeof value.fetchEnabled !== "boolean") return null;

  if (value.fetchEnabled === false) {
    const provider =
      value.provider === undefined ? undefined : parseWebSearchProvider(value.provider);
    if (value.provider !== undefined && !provider) return null;
    return provider ? { provider, fetchEnabled: false } : { fetchEnabled: false };
  }

  const provider =
    value.provider === undefined ? "brave" : parseWebSearchProvider(value.provider);
  if (!provider) return null;
  return {
    provider,
    fetchEnabled: true,
  };
}

export function normalizeWebSearchConfig(value: unknown): WebSearchConfig | null {
  const normalized = normalizePersistedWebSearchConfig(value);
  return normalized?.fetchEnabled === true ? normalized : null;
}

export function getWebSearchCredentialEnvNames(): string[] {
  return listWebSearchProviders().map((provider) => provider.credentialEnv);
}

export function getWebSearchExposureWarningLines(provider: WebSearchProvider): string[] {
  const { label } = getWebSearchProvider(provider);
  return [
    `NemoClaw will store a ${label} API key resolver in sandbox OpenClaw config.`,
    "The OpenClaw agent will be able to resolve and read that key at runtime.",
  ];
}

export function buildWebSearchConfigFragment(
  config: WebSearchConfig | null,
  apiKey: string | null,
): Record<string, unknown> {
  const normalized = normalizeWebSearchConfig(config);
  if (!normalized) return {};

  const { credentialEnv, pluginEntry } = getWebSearchProvider(normalized.provider);
  const apiKeyRef = apiKey ? `openshell:resolve:env:${credentialEnv}` : null;
  return {
    plugins: {
      entries: {
        [pluginEntry]: {
          enabled: true,
          config: {
            webSearch: {
              ...(normalized.provider === "gemini"
                ? { model: DEFAULT_GEMINI_WEB_SEARCH_MODEL }
                : {}),
              ...(apiKeyRef ? { apiKey: apiKeyRef } : {}),
            },
          },
        },
      },
    },
    tools: {
      web: {
        search: {
          enabled: true,
          provider: normalized.provider,
        },
        fetch: {
          enabled: true,
        },
      },
    },
  };
}

export function buildWebSearchDockerConfig(
  config: WebSearchConfig | null,
  apiKey: string | null,
): string {
  return encodeDockerJsonArg(buildWebSearchConfigFragment(config, apiKey));
}
