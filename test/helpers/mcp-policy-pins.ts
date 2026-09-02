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
  const policy = YAML.parse(content) as {
    network_policies: Record<string, { endpoints: Array<{ allowed_ips: string[] }> }>;
  };
  return policy.network_policies[`mcp_bridge_${server}`].endpoints[0].allowed_ips;
}
