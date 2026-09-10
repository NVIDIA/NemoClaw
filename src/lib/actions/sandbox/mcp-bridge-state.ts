// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type AgentDefinition, type AgentMcpAdapter, loadAgent } from "../../agent/defs";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import {
  recoverNamedGatewayRuntime,
  replaceOpenShellRuntimeSelectionEnv,
} from "../../gateway-runtime-action";
import type { SandboxEntry } from "../../state/registry";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import * as registry from "../../state/registry";
import { getSandboxTargetGatewayName } from "./gateway-target";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";
import { validateSandboxName } from "./mcp-bridge-validation";

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

/** Return the configured state directory for a registered agent. */
export function getAgentConfigDir(agentName: string, defaultConfigDir?: string): string {
  try {
    return loadAgent(agentName).configPaths.dir;
  } catch (error) {
    if (defaultConfigDir) return defaultConfigDir;
    throw error;
  }
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
  entry: Pick<McpSourceEntry, "adapter"> | undefined,
  agent: AgentDefinition,
): AgentMcpAdapter | null {
  if (entry && isAgentMcpAdapter(entry.adapter)) return entry.adapter;
  return agent.mcpCapability.support === "bridge" && agent.mcpCapability.adapter
    ? agent.mcpCapability.adapter
    : null;
}

export function assertNoDerivedResourceCollision(
  bridges: Readonly<Record<string, McpSourceEntry>>,
  server: string,
  providerName: string | undefined,
  policyName: string,
): void {
  for (const entry of Object.values(bridges)) {
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

export async function ensureSandboxGatewaySelected(
  sandboxName: string,
  runtimeSelection: OpenShellRuntimeSelection,
): Promise<void> {
  const gatewayName = getSandboxTargetGatewayName(sandboxName);
  const recovery = await recoverNamedGatewayRuntime({
    gatewayName,
    runtimeSelection,
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
  replaceOpenShellRuntimeSelectionEnv(process.env, runtimeSelection);
}
