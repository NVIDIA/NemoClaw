// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MCP_BRIDGE_SHARDS = ["openclaw", "hermes", "deepagents"] as const;
export type McpBridgeShard = (typeof MCP_BRIDGE_SHARDS)[number];

export function resolveMcpBridgeShard(
  value: string | undefined = process.env.NEMOCLAW_MCP_BRIDGE_AGENT,
): McpBridgeShard {
  const selected = value ?? "openclaw";
  if (!MCP_BRIDGE_SHARDS.includes(selected as McpBridgeShard)) {
    throw new Error(`Unsupported NEMOCLAW_MCP_BRIDGE_AGENT: ${selected}`);
  }
  return selected as McpBridgeShard;
}
