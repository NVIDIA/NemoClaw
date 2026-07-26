// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const WEB_SEARCH_PROVIDERS = ["brave", "tavily"] as const;

export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface WebSearchConfig {
  fetchEnabled: boolean;
  /**
   * Optional only for compatibility with sessions and callers created before
   * provider selection existed. Every persistence and runtime boundary
   * normalizes a missing provider to Brave.
   */
  provider?: WebSearchProvider;
}

export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProvider = "brave";
export const WEB_SEARCH_PROVIDER_ENV = "NEMOCLAW_WEB_SEARCH_PROVIDER";
export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return value === "brave" || value === "tavily";
}

export type ExplicitWebSearchProviderSelection =
  | { specified: false; provider: null }
  | { specified: true; provider: WebSearchProvider | null };

export function parseExplicitWebSearchProvider(
  value: string | null | undefined,
): ExplicitWebSearchProviderSelection {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return { specified: false, provider: null };
  if (isWebSearchProvider(normalized)) return { specified: true, provider: normalized };
  if (["none", "off", "disabled", "no", "0"].includes(normalized)) {
    return { specified: true, provider: null };
  }
  throw new Error(
    `Unsupported ${WEB_SEARCH_PROVIDER_ENV}: ${value}. Valid values: brave, tavily, none.`,
  );
}

export function normalizeWebSearchProvider(value: unknown): WebSearchProvider {
  return isWebSearchProvider(value) ? value : DEFAULT_WEB_SEARCH_PROVIDER;
}

export function webSearchProviderForConfig(
  config: Pick<WebSearchConfig, "provider"> | null | undefined,
): WebSearchProvider {
  return normalizeWebSearchProvider(config?.provider);
}

export function webSearchEnvFor(provider: WebSearchProvider): string {
  return provider === "tavily" ? TAVILY_API_KEY_ENV : BRAVE_API_KEY_ENV;
}

export function webSearchLabelFor(provider: WebSearchProvider): string {
  return provider === "tavily" ? "Tavily Search" : "Brave Search";
}

export function webSearchProviderForEnvKey(envKey: string): WebSearchProvider | null {
  if (envKey === BRAVE_API_KEY_ENV) return "brave";
  if (envKey === TAVILY_API_KEY_ENV) return "tavily";
  return null;
}

export function isWebSearchEnabled(
  config: Pick<WebSearchConfig, "fetchEnabled"> | null | undefined,
): boolean {
  return config?.fetchEnabled === true;
}

export function normalizeWebSearchConfig(
  config: Partial<WebSearchConfig> | null | undefined,
): WebSearchConfig | null {
  if (!isWebSearchEnabled(config as WebSearchConfig | null | undefined)) return null;
  const provider =
    config?.provider === undefined
      ? DEFAULT_WEB_SEARCH_PROVIDER
      : isWebSearchProvider(config.provider)
        ? config.provider
        : null;
  if (!provider) return null;
  return {
    fetchEnabled: true,
    provider,
  };
}

export function webSearchConfigsEqual(
  left: Partial<WebSearchConfig> | null | undefined,
  right: Partial<WebSearchConfig> | null | undefined,
): boolean {
  const normalizedLeft = normalizeWebSearchConfig(left);
  const normalizedRight = normalizeWebSearchConfig(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft === normalizedRight;
  return normalizedLeft.provider === normalizedRight.provider;
}
