// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type {
  ExactManagedMcpPolicy,
  ManagedMcpPolicyOmission,
} from "../actions/sandbox/mcp-bridge-policy";
import { diagnosticPreview } from "../name-validation";

const CANONICAL_MANAGED_MCP_POLICY_KEY_RE = /^mcp_bridge_[a-z][a-z0-9_]{0,63}$/;
const RESERVED_MANAGED_MCP_POLICY_KEY_RE = /^mcp_bridge_/;

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
 * Snapshot-time keys are removed first so an MCP server deleted during the
 * shields-down window cannot be restored. The current exact entries are then overlaid,
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
    if (!CANONICAL_MANAGED_MCP_POLICY_KEY_RE.test(key) || snapshotKeys.has(key)) {
      throw new Error("Saved Shields MCP policy ownership is invalid");
    }
    if (!Object.hasOwn(targetPolicies, key)) {
      throw new Error(`Saved Shields MCP policy '${key}' is absent from its policy snapshot`);
    }
    snapshotKeys.add(key);
    delete targetPolicies[key];
  }
  const unclassifiedKey = Object.keys(targetPolicies).find((key) =>
    RESERVED_MANAGED_MCP_POLICY_KEY_RE.test(key),
  );
  if (unclassifiedKey) {
    throw new Error(
      `Reserved MCP policy key ${diagnosticPreview(unclassifiedKey)} is absent from the saved ownership manifest`,
    );
  }

  const currentKeys = new Set<string>();
  for (const policy of currentPolicies) {
    if (!CANONICAL_MANAGED_MCP_POLICY_KEY_RE.test(policy.key) || currentKeys.has(policy.key)) {
      throw new Error(`Managed MCP policy key '${policy.key}' has ambiguous ownership`);
    }
    currentKeys.add(policy.key);
    targetPolicies[policy.key] = policy.networkPolicy;
  }

  target.network_policies = targetPolicies;
  return YAML.stringify(target);
}

export interface DeadlineManagedMcpPolicyComposition {
  yaml: string;
  omissions: ManagedMcpPolicyOmission[];
}

/**
 * Security-authoritative deadline composition.
 *
 * Every reserved key is removed from the snapshot, including keys missing from
 * an incomplete manifest. Only independently proven current entries are then
 * overlaid.
 */
export function composeDeadlineManagedMcpPolicies(
  targetPolicyYaml: string,
  currentPolicies: readonly ExactManagedMcpPolicy[],
  snapshotManagedPolicyKeys: readonly string[],
): DeadlineManagedMcpPolicyComposition {
  const target = parsePolicyDocument(targetPolicyYaml, "Target Shields policy");
  const targetPolicies = readNetworkPolicies(target, "Target Shields policy");

  const snapshotKeys = new Set<string>();
  const omissions: ManagedMcpPolicyOmission[] = [];
  for (const key of snapshotManagedPolicyKeys) {
    if (!CANONICAL_MANAGED_MCP_POLICY_KEY_RE.test(key)) {
      if (RESERVED_MANAGED_MCP_POLICY_KEY_RE.test(key)) {
        delete targetPolicies[key];
      }
      omissions.push({
        key,
        reason: `Saved Shields MCP policy ownership key '${key}' is invalid`,
      });
      continue;
    }
    if (snapshotKeys.has(key)) {
      omissions.push({
        key,
        reason: `Saved Shields MCP policy '${key}' appeared more than once in its ownership manifest`,
      });
      continue;
    }
    if (!Object.hasOwn(targetPolicies, key)) {
      omissions.push({
        reason: `Saved Shields MCP policy '${key}' was already absent from its policy snapshot`,
      });
    }
    snapshotKeys.add(key);
    delete targetPolicies[key];
  }
  for (const key of Object.keys(targetPolicies)) {
    if (!RESERVED_MANAGED_MCP_POLICY_KEY_RE.test(key)) continue;
    delete targetPolicies[key];
    omissions.push({
      key,
      reason: `Reserved MCP policy key '${key}' was absent from the saved ownership manifest`,
    });
  }

  const currentKeys = new Set<string>();
  for (const policy of currentPolicies) {
    if (!CANONICAL_MANAGED_MCP_POLICY_KEY_RE.test(policy.key) || currentKeys.has(policy.key)) {
      throw new Error(`Managed MCP policy key '${policy.key}' has ambiguous ownership`);
    }
    currentKeys.add(policy.key);
    targetPolicies[policy.key] = policy.networkPolicy;
  }

  target.network_policies = targetPolicies;
  return { yaml: YAML.stringify(target), omissions };
}

export function isManagedMcpPolicyKey(value: unknown): value is string {
  return typeof value === "string" && RESERVED_MANAGED_MCP_POLICY_KEY_RE.test(value);
}

/**
 * Refuse to guess managed ownership for a Shields snapshot captured before the
 * ownership manifest existed. Current claims prove reconciliation is needed;
 * a managed-shaped snapshot key may be a removed bridge or an operator entry.
 * Either case requires explicit recovery instead of a destructive raw apply.
 */
export function assertLegacyMcpPolicyRestoreSafe(
  snapshotPolicyYaml: string,
  hasCurrentManagedClaims: boolean,
): void {
  const snapshot = parsePolicyDocument(snapshotPolicyYaml, "Legacy Shields policy snapshot");
  const snapshotPolicies = readNetworkPolicies(snapshot, "Legacy Shields policy snapshot");
  if (
    hasCurrentManagedClaims ||
    Object.keys(snapshotPolicies).some((key) => isManagedMcpPolicyKey(key))
  ) {
    throw new Error(
      "Legacy Shields state has no managed MCP ownership manifest; refusing policy restore",
    );
  }
}
