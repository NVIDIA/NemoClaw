// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const WEB_SEARCH_PROVIDERS = ["brave", "tavily"] as const;

export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return value === "brave" || value === "tavily";
}
