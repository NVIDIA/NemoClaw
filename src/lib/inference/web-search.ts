// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type WebSearchProvider = "brave" | "tavily";

export interface WebSearchConfig {
  fetchEnabled: boolean;
  provider?: WebSearchProvider;
}

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
export const WEB_SEARCH_PROVIDER_ENV = "NEMOCLAW_WEB_SEARCH_PROVIDER";

export function resolveWebSearchProvider(
  config: WebSearchConfig | null | undefined,
): WebSearchProvider | null {
  if (!config?.fetchEnabled) return null;
  return config.provider === "tavily" ? "tavily" : "brave";
}

export function webSearchPolicyPresetForProvider(provider: WebSearchProvider): string {
  return provider;
}

/** User-facing line confirming which web search backend is active. */
export function webSearchUsageMessage(config: WebSearchConfig | null | undefined): string | null {
  const provider = resolveWebSearchProvider(config);
  if (!provider) return null;
  return provider === "tavily" ? "Tavily Web Search is used" : "Brave Web Search is used";
}
