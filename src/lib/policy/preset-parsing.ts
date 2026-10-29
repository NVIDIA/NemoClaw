// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";
import YAML from "yaml";

import { isObjectRecord, type JsonObject, type JsonValue } from "../core/json-types";
import { DEFAULT_VLLM_PORT, VLLM_PORT } from "../core/vllm-port";
import { TAVILY_POLICY_BINDING_PROVIDER_PROFILE_ID } from "../inference/web-search/provider-profile";
import { isDcodeAgent } from "../onboard/observability-policy-presets";

export type PolicyValue = JsonValue;
export type PolicyObject = JsonObject;
export type PolicyDocument = PolicyObject & {
  version?: number;
  network_policies?: PolicyObject;
};

export function isPolicyDocument(value: PolicyValue): value is PolicyDocument {
  return isObjectRecord(value);
}

export function isPolicyObject(value: PolicyValue): value is PolicyObject {
  return isObjectRecord(value);
}

export function isPresetPolicyMap(value: PolicyValue): value is PolicyObject {
  return (
    isPolicyObject(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(isPolicyObject)
  );
}

export function parseNetworkPolicies(content: string | null | undefined): PolicyObject | null {
  if (!content) return null;
  try {
    const parsed = YAML.parse(content);
    const networkPolicies = isPolicyDocument(parsed) ? parsed.network_policies : null;
    return isPolicyObject(networkPolicies) ? networkPolicies : null;
  } catch {
    return null;
  }
}

type PricingPolicy = {
  network_policies?: Record<string, { endpoints?: Array<Record<string, unknown>> }>;
};

/** Keep the built-in pricing rule consistent with an already attached provider route. */
export function materializeOpenClawPricingPins(
  currentPolicy: string,
  presetContent: string,
): string {
  let current: PricingPolicy;
  let preset: PricingPolicy;
  try {
    current = YAML.parse(currentPolicy) as PricingPolicy;
    preset = YAML.parse(presetContent) as PricingPolicy;
  } catch {
    throw new Error("Cannot apply OpenClaw pricing: the current or built-in policy is invalid.");
  }
  if (
    !current ||
    typeof current !== "object" ||
    (current.network_policies !== undefined &&
      (typeof current.network_policies !== "object" ||
        current.network_policies === null ||
        Array.isArray(current.network_policies)))
  ) {
    throw new Error(
      "Cannot apply OpenClaw pricing: the current policy has no valid network policies.",
    );
  }
  const overlapping = Object.entries(current.network_policies ?? {})
    .filter(([key]) => key !== "openclaw-pricing")
    .flatMap(([key, policy]) =>
      (Array.isArray(policy?.endpoints) ? policy.endpoints : [])
        .filter((endpoint) => endpoint.host === "openrouter.ai" && endpoint.port === 443)
        .map((endpoint) => ({ key, endpoint })),
    );
  if (overlapping.length === 0) return presetContent;

  const pricing = preset?.network_policies?.["openclaw-pricing"]?.endpoints?.find(
    (endpoint) => endpoint.host === "openrouter.ai" && endpoint.port === 443,
  );
  if (!pricing) throw new Error("The built-in OpenClaw pricing preset is invalid.");

  const authorities = overlapping.filter(
    ({ key }) => key.startsWith("_provider_nemoclaw_custom_") || key === "native_hosted_inference",
  );
  if (authorities.length === 0) {
    throw new Error(
      "Cannot apply OpenClaw pricing: no verified OpenRouter provider route owns the overlap.",
    );
  }
  const pins = overlapping.map(({ endpoint }) => endpoint.allowed_ips);
  // The standard hosted OpenRouter provider has no IP pins. Preserve the
  // pre-existing hostname-scoped pricing route when every overlap is unpinned.
  if (pins.every((value) => value == null)) return presetContent;
  const validPins = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((ip) => typeof ip === "string" && isIP(ip) !== 0) &&
    new Set(value).size === value.length;
  if (!pins.every(validPins)) {
    throw new Error(
      "Cannot apply OpenClaw pricing: the overlapping OpenRouter route has no verified IP pins.",
    );
  }
  const expected = [...pins[0]].sort();
  if (
    pins.some(
      (value) =>
        value.length !== expected.length ||
        [...value].sort().some((ip, index) => ip !== expected[index]),
    )
  ) {
    throw new Error(
      "Cannot apply OpenClaw pricing: overlapping OpenRouter routes have conflicting IP pins.",
    );
  }
  pricing.allowed_ips = expected;
  return YAML.stringify(preset);
}

/** Apply the configured vLLM host listener to the built-in local-inference policy. */
export function materializeLocalInferencePresetPorts(content: string): string {
  if (VLLM_PORT === DEFAULT_VLLM_PORT) return content;
  const document = YAML.parse(content) as {
    network_policies?: {
      local_inference?: { endpoints?: Array<{ host?: unknown; port?: unknown }> };
    };
  } | null;
  const endpoints = document?.network_policies?.local_inference?.endpoints;
  if (!Array.isArray(endpoints)) {
    throw new Error("Built-in local-inference policy is missing its endpoint list.");
  }
  const vllmEndpoints = endpoints.filter(
    ({ host, port }) => host === "host.openshell.internal" && port === DEFAULT_VLLM_PORT,
  );
  if (vllmEndpoints.length !== 1) {
    throw new Error("Built-in local-inference policy must define exactly one vLLM endpoint.");
  }
  vllmEndpoints[0].port = VLLM_PORT;
  return YAML.stringify(document);
}

const WEB_SEARCH_PRESET_PROVIDER_SUFFIXES: Readonly<Record<string, string>> = {
  brave: "brave-search",
  tavily: "tavily-search",
};

export function isWebSearchPolicyPreset(presetName: string): boolean {
  return Object.hasOwn(WEB_SEARCH_PRESET_PROVIDER_SUFFIXES, presetName);
}

/**
 * OpenClaw and Hermes register a sandbox-scoped web-search provider during
 * onboarding. Deep Agents registers the gateway-wide name because its opt-in
 * runs after the sandbox exists.
 */
export function webSearchCredentialProviderCandidates(
  presetName: string,
  sandboxName: string,
  agentName: string | null | undefined,
): readonly string[] {
  const suffix = WEB_SEARCH_PRESET_PROVIDER_SUFFIXES[presetName];
  if (!suffix || !sandboxName) return [];
  const scoped = `${sandboxName}-${suffix}`;
  return isDcodeAgent(agentName) ? [suffix, scoped] : [scoped, suffix];
}

export function resolveWebSearchCredentialProvider(input: {
  readonly presetName: string;
  readonly sandboxName: string;
  readonly agentName?: string | null;
  readonly availableProviders: ReadonlySet<string>;
  /**
   * Providers attached to the target sandbox. Omitted for the rebuild handoff,
   * which binds before physical attachment. When present, a candidate the
   * sandbox does not attach does not qualify: the gateway rejects a
   * credential_binding that names an unattached provider.
   */
  readonly attachedProviders?: ReadonlySet<string>;
  /**
   * Observed profile types keyed by provider name. When supplied for Tavily,
   * only a provider that uses tavily-policy-binding-v1 qualifies; OpenShell
   * rejects a credential_binding that names an endpoint-bearing profile.
   */
  readonly providerTypes?: Readonly<Record<string, string | null | undefined>>;
}): string | null {
  for (const candidate of webSearchCredentialProviderCandidates(
    input.presetName,
    input.sandboxName,
    input.agentName,
  )) {
    if (!input.availableProviders.has(candidate)) continue;
    if (input.attachedProviders && !input.attachedProviders.has(candidate)) continue;
    if (
      input.presetName === "tavily" &&
      input.providerTypes &&
      input.providerTypes[candidate] !== TAVILY_POLICY_BINDING_PROVIDER_PROFILE_ID
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * Network contract an endpoint must match before it can receive a web-search
 * credential binding. A binding hands the stored credential to every request
 * the endpoint allows, so the binding is granted only to the destination the
 * checked-in preset declares.
 */
export type WebSearchEndpointContract = Readonly<{
  endpoint: Readonly<Record<string, JsonValue>>;
  host: string;
  port: number;
  protocol: string;
  enforcement: string;
  rules: readonly Readonly<Record<string, JsonValue>>[];
  requestBodyCredentialRewrite: boolean;
}>;

function contractString(value: JsonValue): string | null {
  return typeof value === "string" ? value : null;
}

function contractNumber(value: JsonValue): number | null {
  return typeof value === "number" ? value : null;
}

function contractRules(value: JsonValue): WebSearchEndpointContract["rules"] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPolicyObject)) return null;
  return value;
}

/**
 * Derive the endpoint contract from the checked-in preset content. The preset
 * is the only authority for the destination that may receive the credential, so
 * a preset that does not declare exactly one complete endpoint has no contract
 * and receives no binding.
 */
export function parseWebSearchEndpointContract(
  presetContent: string,
  presetName: string,
): WebSearchEndpointContract | null {
  let parsed: PolicyValue;
  try {
    parsed = YAML.parse(presetContent);
  } catch {
    return null;
  }
  if (!isPolicyDocument(parsed) || !isPolicyObject(parsed.network_policies)) return null;
  const policy = parsed.network_policies[presetName];
  if (!isPolicyObject(policy) || !Array.isArray(policy.endpoints)) return null;
  if (policy.endpoints.length !== 1 || !isPolicyObject(policy.endpoints[0])) return null;
  const endpoint = policy.endpoints[0];
  if (Object.hasOwn(endpoint, "credential_binding")) return null;
  const host = contractString(endpoint.host);
  const port = contractNumber(endpoint.port);
  const protocol = contractString(endpoint.protocol);
  const enforcement = contractString(endpoint.enforcement);
  const rules = contractRules(endpoint.rules);
  if (!host || port === null || !protocol || !enforcement || !rules) return null;
  return {
    endpoint,
    host,
    port,
    protocol,
    enforcement,
    rules,
    requestBodyCredentialRewrite: endpoint.request_body_credential_rewrite === true,
  };
}

function matchesWebSearchEndpointContract(
  endpoint: PolicyObject,
  contract: WebSearchEndpointContract,
): boolean {
  const candidate = { ...endpoint };
  delete candidate.credential_binding;
  return isDeepStrictEqual(candidate, contract.endpoint);
}

/**
 * Bind a web-search preset endpoint to the provider that holds its credential.
 * OpenShell resolves a static credential only at an endpoint that names its
 * provider, so an unbound endpoint denies the request after the network and L7
 * stages allow it. The binding is added only to an endpoint that matches the
 * checked-in preset contract; a substituted or added endpoint keeps none of
 * the credential.
 */
export function applyWebSearchCredentialBinding(
  content: string,
  presetName: string,
  providerName: string | null,
  contract: WebSearchEndpointContract | null,
): string {
  if (!providerName || !contract) return content;
  let parsed: PolicyValue;
  try {
    parsed = YAML.parse(content);
  } catch {
    return content;
  }
  if (!isPolicyDocument(parsed) || !isPolicyObject(parsed.network_policies)) return content;
  const policy = parsed.network_policies[presetName];
  if (!isPolicyObject(policy) || !Array.isArray(policy.endpoints)) return content;
  let changed = false;
  for (const endpoint of policy.endpoints) {
    // An existing binding is never replaced, and an endpoint that differs from
    // the checked-in contract receives none of the stored credential.
    if (
      !isPolicyObject(endpoint) ||
      Object.hasOwn(endpoint, "credential_binding") ||
      !matchesWebSearchEndpointContract(endpoint, contract)
    ) {
      continue;
    }
    endpoint.credential_binding = { provider: providerName };
    changed = true;
  }
  return changed ? YAML.stringify(parsed) : content;
}

/**
 * Bind every web-search policy already present in a sandbox policy document.
 * Only providers the sandbox create plan attaches qualify: a binding that names
 * any other provider fails the create-time provider check.
 */
export function bindWebSearchPresetProviders(input: {
  readonly content: string;
  readonly sandboxName: string;
  readonly agentName?: string | null;
  readonly availableProviders: ReadonlySet<string>;
  readonly attachedProviders?: ReadonlySet<string> | null;
  readonly providerTypes?: Readonly<Record<string, string | null | undefined>>;
  readonly contracts?: Readonly<Record<string, WebSearchEndpointContract | null>>;
}): string {
  if (input.attachedProviders === null) return input.content;
  let content = input.content;
  for (const presetName of Object.keys(WEB_SEARCH_PRESET_PROVIDER_SUFFIXES)) {
    // Hermes Tavily and every Brave provider use an endpoint-bearing profile.
    // A policy binding that names that provider is rejected, and the profile
    // attachment delivers the credential itself.
    if (
      presetName === "brave" ||
      (presetName === "tavily" && input.agentName?.trim().toLowerCase() === "hermes")
    ) {
      continue;
    }
    const providerName = resolveWebSearchCredentialProvider({
      presetName,
      sandboxName: input.sandboxName,
      agentName: input.agentName,
      availableProviders: input.availableProviders,
      attachedProviders: input.attachedProviders,
      providerTypes: input.providerTypes,
    });
    content = applyWebSearchCredentialBinding(
      content,
      presetName,
      providerName,
      input.contracts?.[presetName] ?? null,
    );
  }
  return content;
}

let cachedWebSearchContracts: Record<string, WebSearchEndpointContract | null> | null = null;

/**
 * Parse and cache the checked-in web-search preset endpoint contracts once so
 * live policy loading and rebuild handoff share the same contract source.
 */
export function getWebSearchPresetContracts(
  loadPresetContent?: (presetName: string) => string | null,
): Readonly<Record<string, WebSearchEndpointContract | null>> {
  if (cachedWebSearchContracts) return cachedWebSearchContracts;
  const contracts: Record<string, WebSearchEndpointContract | null> = {};
  for (const presetName of Object.keys(WEB_SEARCH_PRESET_PROVIDER_SUFFIXES)) {
    const content = loadPresetContent ? loadPresetContent(presetName) : null;
    contracts[presetName] = content ? parseWebSearchEndpointContract(content, presetName) : null;
  }
  if (loadPresetContent) cachedWebSearchContracts = contracts;
  return contracts;
}
