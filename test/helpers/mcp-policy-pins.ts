// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { expect } from "vitest";

import { getRegisteredGeneratedPolicy } from "../../src/lib/actions/sandbox/mcp-bridge-policy";
import type { McpBridgeEntry } from "../../src/lib/state/registry";
import * as registry from "../../src/lib/state/registry";

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

export function expectMcpPolicyAndRegistryPins(
  sandboxName: string,
  entry: McpBridgeEntry,
  expectedPins: string[],
  policyApplyCalls: readonly (readonly unknown[])[],
  expectedBinary = "",
): void {
  const persistedEntry = registry.getSandbox(sandboxName)?.mcp?.bridges[entry.server];
  const activePolicyContent = lastAppliedMcpPolicyContent(policyApplyCalls, entry.policyName);
  const registeredPolicy = getRegisteredGeneratedPolicy(sandboxName, persistedEntry);

  expect(persistedEntry?.allowedIps).toEqual(expectedPins);
  expect(mcpPolicyAllowedIps(activePolicyContent, entry.server)).toEqual(expectedPins);
  expect(activePolicyContent).toContain(expectedBinary);
  expect(registeredPolicy?.content).toBe(activePolicyContent);
}
