// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type { ExactManagedMcpPolicy } from "../actions/sandbox/mcp-bridge-policy";

const MANAGED_MCP_POLICY_KEY_RE = /^mcp_bridge_[a-z][a-z0-9_]{0,63}$/;

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
 * Reconcile generated MCP entries into a complete target policy.
 *
 * Snapshot-time keys are removed first so an MCP server deleted while Shields
 * are down cannot be resurrected. The current exact entries are then overlaid,
 * retaining additions and replacing stale pins. Every non-MCP target entry
 * remains authoritative; unrelated live entries are never copied.
 */
export function composeManagedMcpPolicies(
  targetPolicyYaml: string,
  currentPolicies: readonly ExactManagedMcpPolicy[],
  snapshotManagedPolicyKeys: readonly string[] = [],
): string {
  const target = parsePolicyDocument(targetPolicyYaml, "Target Shields policy");
  const targetPolicies = readNetworkPolicies(target, "Target Shields policy");

  const snapshotKeys = new Set<string>();
  for (const key of snapshotManagedPolicyKeys) {
    if (!MANAGED_MCP_POLICY_KEY_RE.test(key) || snapshotKeys.has(key)) {
      throw new Error("Saved Shields MCP policy ownership is invalid");
    }
    snapshotKeys.add(key);
    delete targetPolicies[key];
  }

  const currentKeys = new Set<string>();
  for (const policy of currentPolicies) {
    if (!MANAGED_MCP_POLICY_KEY_RE.test(policy.key) || currentKeys.has(policy.key)) {
      throw new Error(`Managed MCP policy key '${policy.key}' has ambiguous ownership`);
    }
    currentKeys.add(policy.key);
    targetPolicies[policy.key] = policy.networkPolicy;
  }

  target.network_policies = targetPolicies;
  return YAML.stringify(target);
}

export function isManagedMcpPolicyKey(value: unknown): value is string {
  return typeof value === "string" && MANAGED_MCP_POLICY_KEY_RE.test(value);
}
