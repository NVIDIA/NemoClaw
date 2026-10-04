// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MCP_BRIDGE_SHARDS = ["openclaw", "hermes", "deepagents"] as const;
export type McpBridgeShard = (typeof MCP_BRIDGE_SHARDS)[number];

export const MCP_BRIDGE_E2E_SCOPES = ["full", "managed-image-discovery"] as const;
export type McpBridgeE2eScope = (typeof MCP_BRIDGE_E2E_SCOPES)[number];

export function resolveMcpBridgeShard(
  value: string | undefined = process.env.NEMOCLAW_MCP_BRIDGE_AGENT,
): McpBridgeShard {
  const selected = value ?? "openclaw";
  if (!MCP_BRIDGE_SHARDS.includes(selected as McpBridgeShard)) {
    throw new Error(`Unsupported NEMOCLAW_MCP_BRIDGE_AGENT: ${selected}`);
  }
  return selected as McpBridgeShard;
}

export function resolveMcpBridgeE2eScope(
  value: string | undefined = process.env.NEMOCLAW_MCP_BRIDGE_E2E_SCOPE,
): McpBridgeE2eScope {
  const selected = value ?? "full";
  if (!MCP_BRIDGE_E2E_SCOPES.includes(selected as McpBridgeE2eScope)) {
    throw new Error(`Unsupported NEMOCLAW_MCP_BRIDGE_E2E_SCOPE: ${selected}`);
  }
  return selected as McpBridgeE2eScope;
}

export async function runFullMcpBridgeE2eCoverage<T>(
  scope: McpBridgeE2eScope,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  if (scope !== "full") return undefined;
  return operation();
}
