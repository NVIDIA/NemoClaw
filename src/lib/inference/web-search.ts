// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type WebSearchProvider = "brave" | "duckduckgo";

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = ["brave", "duckduckgo"];

export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProvider = "brave";

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return WEB_SEARCH_PROVIDERS.includes(value as WebSearchProvider);
}

export function normalizeWebSearchProvider(value: unknown): WebSearchProvider {
  return isWebSearchProvider(value) ? value : DEFAULT_WEB_SEARCH_PROVIDER;
}

export interface WebSearchConfig {
  fetchEnabled: boolean;
  provider?: WebSearchProvider;
}

export function isWebSearchEnabled(
  webSearchConfig: { fetchEnabled?: boolean | null } | null | undefined,
): boolean {
  return webSearchConfig?.fetchEnabled === true;
}

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
