// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
