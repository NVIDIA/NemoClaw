// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

export function lastAppliedMcpPolicyContent(
  calls: readonly (readonly unknown[])[],
  policyName: string,
): string {
  const content = calls.filter((call) => call[1] === policyName).at(-1)?.[2];
  return typeof content === "string" ? content : "";
}

export function mcpPolicyAllowedIps(content: string, server: string): string[] {
  const policyName = `mcp_bridge_${server}`;
  const policy = YAML.parse(content) as unknown;
  const networkPolicies =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).network_policies
      : undefined;
  const selectedPolicy =
    networkPolicies && typeof networkPolicies === "object" && !Array.isArray(networkPolicies)
      ? (networkPolicies as Record<string, unknown>)[policyName]
      : undefined;
  const endpoints =
    selectedPolicy && typeof selectedPolicy === "object" && !Array.isArray(selectedPolicy)
      ? (selectedPolicy as Record<string, unknown>).endpoints
      : undefined;
  const firstEndpoint = Array.isArray(endpoints) ? endpoints[0] : undefined;
  const allowedIps =
    firstEndpoint && typeof firstEndpoint === "object" && !Array.isArray(firstEndpoint)
      ? (firstEndpoint as Record<string, unknown>).allowed_ips
      : undefined;
  if (!Array.isArray(allowedIps) || !allowedIps.every((address) => typeof address === "string")) {
    throw new Error(
      `MCP policy '${policyName}' for server '${server}' has no first endpoint with string allowed_ips.`,
    );
  }
  return allowedIps;
}
