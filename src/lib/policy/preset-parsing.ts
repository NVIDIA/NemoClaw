// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import YAML from "yaml";

import { isObjectRecord, type JsonObject, type JsonValue } from "../core/json-types";
import { DEFAULT_VLLM_PORT, VLLM_PORT } from "../core/vllm-port";

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
