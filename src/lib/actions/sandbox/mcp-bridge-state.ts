// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type AgentDefinition, type AgentMcpAdapter, loadAgent } from "../../agent/defs";
import { recoverNamedGatewayRuntime } from "../../gateway-runtime-action";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { getSandboxTargetGatewayName } from "./gateway-target";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSandboxOrThrow(sandboxName: string): SandboxEntry {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    throw new McpBridgeError(`Sandbox '${sandboxName}' not found.`, 1);
  }
  return sandbox;
}

function getSandboxAgentName(sandbox: SandboxEntry): string {
  return sandbox.agent || "openclaw";
}

export function getSandboxAgent(sandbox: SandboxEntry): AgentDefinition {
  return loadAgent(getSandboxAgentName(sandbox));
}

function unsupportedMessage(agent: AgentDefinition): string {
  const reason = agent.mcpCapability.reason
    ? ` ${agent.mcpCapability.reason}`
    : " MCP support is disabled for this agent.";
  return `${agent.displayName} does not support managed MCP servers yet.${reason} Issue #566 tracks future design.`;
}

function assertBridgeSupported(agent: AgentDefinition): void {
  if (agent.mcpCapability.support === "bridge") return;
  throw new McpBridgeError(unsupportedMessage(agent), 1);
}

export function getBridgeAdapter(agent: AgentDefinition): AgentMcpAdapter {
  assertBridgeSupported(agent);
  const adapter = agent.mcpCapability.adapter;
  if (!adapter) {
    throw new McpBridgeError(
      `${agent.displayName} declares MCP support but does not declare an adapter.`,
      1,
    );
  }
  return adapter;
}

export function getEntryAdapter(
  entry: Pick<McpBridgeEntry, "adapter"> | undefined,
  agent: AgentDefinition,
): AgentMcpAdapter | null {
  if (entry && isAgentMcpAdapter(entry.adapter)) return entry.adapter;
  return agent.mcpCapability.support === "bridge" && agent.mcpCapability.adapter
    ? agent.mcpCapability.adapter
    : null;
}

export function bridgeState(sandbox: SandboxEntry): Record<string, McpBridgeEntry> {
  return sandbox.mcp?.bridges ?? {};
}

export function setBridgeState(sandboxName: string, bridges: Record<string, McpBridgeEntry>): void {
  const mcpState = registry.getSandbox(sandboxName)?.mcp;
  const destroyPreparedAt = mcpState?.destroyPreparedAt;
  const destroyPendingAt = mcpState?.destroyPendingAt;
  const hasDestroyState = !!destroyPreparedAt || !!destroyPendingAt;
  const updated = registry.updateSandbox(sandboxName, {
    mcp:
      Object.keys(bridges).length > 0 || hasDestroyState
        ? {
            bridges,
            ...(destroyPreparedAt ? { destroyPreparedAt } : {}),
            ...(destroyPendingAt ? { destroyPendingAt } : {}),
          }
        : undefined,
  });
  if (!updated) {
    throw new McpBridgeError(`Could not persist MCP lifecycle state for sandbox '${sandboxName}'.`);
  }
}

export function assertMcpDestroyNotPending(sandbox: SandboxEntry): void {
  if (!sandbox.mcp?.destroyPreparedAt && !sandbox.mcp?.destroyPendingAt) return;
  throw new McpBridgeError(
    `Sandbox '${sandbox.name}' has an incomplete MCP destroy transaction. Re-run the sandbox destroy command to finish cleanup before using MCP commands.`,
  );
}

export function assertNoDerivedResourceCollision(
  sandbox: SandboxEntry,
  server: string,
  providerName: string | undefined,
  policyName: string,
): void {
  const conflictingCustomPolicy = sandbox.customPolicies?.find(
    (policy) => policy.name === policyName && policy.sourcePath !== MCP_BRIDGE_POLICY_SOURCE,
  );
  if (conflictingCustomPolicy || sandbox.policies?.includes(policyName)) {
    throw new McpBridgeError(
      `Generated MCP policy name '${policyName}' conflicts with an existing non-MCP policy. Choose a different server name.`,
      2,
    );
  }
  for (const entry of Object.values(bridgeState(sandbox))) {
    if (entry.server === server) continue;
    const providerCollision =
      providerName !== undefined &&
      entry.providerName !== undefined &&
      entry.providerName === providerName;
    if (providerCollision || entry.policyName === policyName) {
      throw new McpBridgeError(
        `MCP server '${server}' conflicts with existing server '${entry.server}' after OpenShell resource-name normalization. Choose a name that differs beyond case, hyphens, and underscores.`,
        2,
      );
    }
  }
}

export function writeBridgeEntry(sandboxName: string, entry: McpBridgeEntry): void {
  const sandbox = getSandboxOrThrow(sandboxName);
  const bridges = { ...bridgeState(sandbox), [entry.server]: entry };
  setBridgeState(sandboxName, bridges);
}

export function removeBridgeEntry(sandboxName: string, server: string): void {
  const sandbox = getSandboxOrThrow(sandboxName);
  const bridges = { ...bridgeState(sandbox) };
  delete bridges[server];
  setBridgeState(sandboxName, bridges);
}

export async function ensureSandboxGatewaySelected(sandboxName: string): Promise<void> {
  const gatewayName = getSandboxTargetGatewayName(sandboxName);
  const recovery = await recoverNamedGatewayRuntime({
    gatewayName,
  });
  if (!recovery.recovered || recovery.after.state !== "healthy_named") {
    throw new McpBridgeError(
      `Could not select healthy OpenShell gateway '${gatewayName}' for sandbox '${sandboxName}' (before: ${recovery.before.state}, after: ${recovery.after.state}). Refusing to mutate MCP resources on another gateway.`,
    );
  }
  // Pin every subsequent OpenShell subprocess in this lifecycle operation to
  // the sandbox's recorded gateway. The globally selected gateway is mutable
  // shared metadata and another NemoClaw process may select a sibling between
  // this health check and the provider/policy mutation.
  process.env.OPENSHELL_GATEWAY = gatewayName;
}
