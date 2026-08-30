// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

const MCP_POLICY_KEY_PREFIX = "mcp_bridge_";

function parsePolicyDocument(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch {
    throw new Error(`${label} is not valid YAML`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

function readNetworkPolicies(
  document: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const policies = document.network_policies;
  if (policies === undefined || policies === null) return {};
  if (typeof policies !== "object" || Array.isArray(policies)) {
    throw new Error(`${label} network_policies must be a mapping`);
  }
  return policies as Record<string, unknown>;
}

function exactEndpointSignatures(policy: unknown): Set<string> {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return new Set();
  const endpoints = (policy as Record<string, unknown>).endpoints;
  if (!Array.isArray(endpoints)) return new Set();
  const signatures = new Set<string>();
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) continue;
    const record = endpoint as Record<string, unknown>;
    const host = typeof record.host === "string" ? record.host : "";
    const ports = Array.isArray(record.ports) ? record.ports : [record.port];
    for (const port of ports) {
      if (host && (typeof port === "number" || typeof port === "string")) {
        signatures.add(`${host}:${String(port)}`);
      }
    }
  }
  return signatures;
}

function withoutExactLiveEndpointCollisions(
  targetKey: string,
  targetPolicy: unknown,
  livePolicies: Record<string, unknown>,
): unknown | null {
  if (!targetPolicy || typeof targetPolicy !== "object" || Array.isArray(targetPolicy)) {
    return targetPolicy;
  }
  const record = targetPolicy as Record<string, unknown>;
  if (!Array.isArray(record.endpoints)) return targetPolicy;
  const liveEndpoints = new Set(
    Object.entries(livePolicies).flatMap(([liveKey, livePolicy]) =>
      liveKey === targetKey ? [] : [...exactEndpointSignatures(livePolicy)],
    ),
  );
  if (liveEndpoints.size === 0) return targetPolicy;
  const endpoints = record.endpoints.filter((endpoint) => {
    const signatures = exactEndpointSignatures({ endpoints: [endpoint] });
    return signatures.size === 0 || ![...signatures].some((item) => liveEndpoints.has(item));
  });
  if (endpoints.length === record.endpoints.length) return targetPolicy;
  return endpoints.length > 0 ? { ...record, endpoints } : null;
}

/**
 * Preserve OpenShell's live policy while composing a temporary Shields policy.
 * The target's intentional permissive entries win ordinary name collisions;
 * live MCP entries win because their exact runtime-generated content has no
 * static equivalent. Every other live-only entry is carried through unchanged.
 */
export function composeLiveNetworkPolicies(
  targetPolicyYaml: string,
  livePolicyYaml: string,
): string {
  const target = parsePolicyDocument(targetPolicyYaml, "Target Shields policy");
  const targetPolicies = readNetworkPolicies(target, "Target Shields policy");
  const live = parsePolicyDocument(livePolicyYaml, "Live OpenShell policy");
  const livePolicies = readNetworkPolicies(live, "Live OpenShell policy");

  for (const [key, policy] of Object.entries(targetPolicies)) {
    const reconciled = withoutExactLiveEndpointCollisions(key, policy, livePolicies);
    if (reconciled === null) delete targetPolicies[key];
    else targetPolicies[key] = reconciled;
  }

  for (const [key, policy] of Object.entries(livePolicies)) {
    if (key.startsWith(MCP_POLICY_KEY_PREFIX) || !Object.hasOwn(targetPolicies, key)) {
      targetPolicies[key] = structuredClone(policy);
    }
  }

  target.network_policies = targetPolicies;
  return YAML.stringify(target);
}
