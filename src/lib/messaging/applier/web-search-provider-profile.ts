// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const BRAVE_PROVIDER_PROFILE_ID = "brave";
export const TAVILY_PROVIDER_PROFILE_ID = "tavily";
// OpenShell custom profiles are immutable after import. Use a versioned Hermes
// profile so upgrades never accept the earlier Deep Agents-only Tavily binary
// allowlist as compatible with Hermes.
export const HERMES_TAVILY_PROVIDER_PROFILE_ID = "tavily-hermes-v1";
export const WEB_SEARCH_PROVIDER_PROFILE_IDS = [
  BRAVE_PROVIDER_PROFILE_ID,
  TAVILY_PROVIDER_PROFILE_ID,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
] as const;
export type WebSearchProviderProfileId = (typeof WEB_SEARCH_PROVIDER_PROFILE_IDS)[number];
export const TAVILY_PROVIDER_PROFILE_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;

export function webSearchProviderProfileId(provider: string, agentName?: string | null): string {
  return provider === TAVILY_PROVIDER_PROFILE_ID && agentName?.trim().toLowerCase() === "hermes"
    ? HERMES_TAVILY_PROVIDER_PROFILE_ID
    : provider;
}

export function webSearchProviderProfilePath(
  root: string,
  provider: WebSearchProviderProfileId,
): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${provider}.yaml`);
}
