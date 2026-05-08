// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type WebSearchProvider = "brave" | "tavily";

export interface WebSearchConfig {
  fetchEnabled: boolean;
  provider: WebSearchProvider;
}

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";

export function webSearchEnvFor(provider: WebSearchProvider): string {
  return provider === "tavily" ? TAVILY_API_KEY_ENV : BRAVE_API_KEY_ENV;
}
