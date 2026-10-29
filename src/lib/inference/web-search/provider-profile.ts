// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const BRAVE_PROVIDER_PROFILE_ID = "brave";
export const TAVILY_PROVIDER_PROFILE_ID = "tavily";
// OpenShell custom profiles are immutable after import. Use a versioned Hermes
// profile so upgrades never accept the earlier Deep Agents-only Tavily binary
// allowlist as compatible with Hermes.
export const HERMES_TAVILY_PROVIDER_PROFILE_ID = "tavily-hermes-v1";
// Endpointless carrier for a Tavily credential that the tavily policy preset
// binds. The pinned OpenShell release rejects a credential_binding that names a
// provider whose profile declares endpoints, and it withholds the credential of
// an endpointless profile until the policy names that provider.
export const TAVILY_POLICY_BINDING_PROVIDER_PROFILE_ID = "tavily-policy-binding-v1";
export const WEB_SEARCH_PROVIDER_PROFILE_IDS = [
  BRAVE_PROVIDER_PROFILE_ID,
  TAVILY_PROVIDER_PROFILE_ID,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
  TAVILY_POLICY_BINDING_PROVIDER_PROFILE_ID,
] as const;
export type WebSearchProviderProfileId = (typeof WEB_SEARCH_PROVIDER_PROFILE_IDS)[number];
export const TAVILY_PROVIDER_PROFILE_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;

export function webSearchProviderProfileId<Provider extends string>(
  provider: Provider,
  agentName?: string | null,
):
  | Provider
  | typeof HERMES_TAVILY_PROVIDER_PROFILE_ID
  | typeof TAVILY_POLICY_BINDING_PROVIDER_PROFILE_ID {
  if (provider !== TAVILY_PROVIDER_PROFILE_ID) return provider;
  // Hermes keeps its versioned profile. That profile declares the Tavily
  // endpoint, so its attachment delivers the credential without a policy
  // binding. Every other agent stores the credential in the endpointless
  // carrier, and the tavily preset binding is what delivers it.
  return agentName?.trim().toLowerCase() === "hermes"
    ? HERMES_TAVILY_PROVIDER_PROFILE_ID
    : TAVILY_POLICY_BINDING_PROVIDER_PROFILE_ID;
}
