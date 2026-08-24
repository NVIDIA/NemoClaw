// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import { isAgentMcpAdapter } from "../../../agent/definition-types";
import type { SandboxEntry } from "../../../state/registry";
import { buildMcpBridgePolicyName, buildMcpBridgePolicyYaml } from "../mcp-bridge-policy";
import { preflightMcpEntryTargets } from "../mcp-bridge-provider";
import { assertAuthenticatedBridgeEntry } from "../mcp-bridge-validation";

/** Build exact MCP policy requirements from durable bridges and current target pins. */
export async function resolveManagedMcpPolicyRequirementContents(
  sandboxEntry: SandboxEntry,
  operation: string,
): Promise<string[]> {
  const mcp = sandboxEntry.mcp;
  if (!mcp) return [];
  if (mcp.destroyPreparedAt || mcp.destroyPendingAt) {
    throw new Error(`Refusing to ${operation}: managed MCP destruction is incomplete.`);
  }

  const bridges = Object.values(mcp.bridges).sort((left, right) =>
    left.server.localeCompare(right.server),
  );
  for (const bridge of bridges) {
    if (bridge.addState) {
      throw new Error(
        `Refusing to ${operation}: managed MCP server '${bridge.server}' has an incomplete add transaction.`,
      );
    }
    assertAuthenticatedBridgeEntry(bridge);
    if (!bridge.providerId) {
      throw new Error(
        `Refusing to ${operation}: managed MCP server '${bridge.server}' has no exact provider identity.`,
      );
    }
    if (!isAgentMcpAdapter(bridge.adapter)) {
      throw new Error(
        `Refusing to ${operation}: managed MCP server '${bridge.server}' has no exact adapter identity.`,
      );
    }
    if (bridge.policyName !== buildMcpBridgePolicyName(bridge.server)) {
      throw new Error(
        `Refusing to ${operation}: managed MCP server '${bridge.server}' has a non-canonical policy name.`,
      );
    }
  }

  let targets: Awaited<ReturnType<typeof preflightMcpEntryTargets>>;
  try {
    targets = await preflightMcpEntryTargets(bridges);
  } catch (error) {
    throw new Error(
      `Refusing to ${operation}: managed MCP target pins could not be validated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return bridges.map((bridge) => {
    const adapter = bridge.adapter;
    if (!isAgentMcpAdapter(adapter)) {
      throw new Error(
        `Refusing to ${operation}: managed MCP server '${bridge.server}' has no exact adapter identity.`,
      );
    }
    const providerName = bridge.providerName;
    if (typeof providerName !== "string" || providerName.length === 0) {
      throw new Error(
        `Refusing to ${operation}: managed MCP server '${bridge.server}' has no exact provider name.`,
      );
    }
    const target = targets.get(bridge.server);
    if (!target) {
      throw new Error(
        `Refusing to ${operation}: managed MCP server '${bridge.server}' has no validated target pins.`,
      );
    }
    const requiredPolicy = YAML.parse(
      buildMcpBridgePolicyYaml(bridge.server, bridge.url, adapter, target, providerName),
    ) as Record<string, unknown>;
    delete requiredPolicy.preset;
    return YAML.stringify(requiredPolicy);
  });
}
