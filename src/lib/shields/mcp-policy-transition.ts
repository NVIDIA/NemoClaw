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

  for (const [key, policy] of Object.entries(livePolicies)) {
    if (key.startsWith(MCP_POLICY_KEY_PREFIX) || !Object.hasOwn(targetPolicies, key)) {
      targetPolicies[key] = structuredClone(policy);
    }
  }

  target.network_policies = targetPolicies;
  return YAML.stringify(target);
}
