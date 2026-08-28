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

/**
 * Preserve the live MCP policy namespace while composing a temporary Shields
 * policy. OpenShell is the authority for both the keys and their content; MCP
 * registry state is deliberately not consulted or used as an ownership claim.
 */
export function composeLiveMcpPolicies(targetPolicyYaml: string, livePolicyYaml: string): string {
  const target = parsePolicyDocument(targetPolicyYaml, "Target Shields policy");
  const targetPolicies = readNetworkPolicies(target, "Target Shields policy");
  const live = parsePolicyDocument(livePolicyYaml, "Live OpenShell policy");
  const livePolicies = readNetworkPolicies(live, "Live OpenShell policy");

  for (const [key, policy] of Object.entries(livePolicies)) {
    if (key.startsWith(MCP_POLICY_KEY_PREFIX)) targetPolicies[key] = structuredClone(policy);
  }

  target.network_policies = targetPolicies;
  return YAML.stringify(target);
}
