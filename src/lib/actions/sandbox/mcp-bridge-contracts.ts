// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";

export const MCP_BRIDGE_POLICY_SOURCE = "generated:nemoclaw-mcp-bridge";
export class McpBridgeError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "McpBridgeError";
  }
}

export interface ParsedEnvReference {
  name: string;
  value?: string;
}

export interface ParsedMcpAddArgs {
  server: string;
  url: string;
  env: ParsedEnvReference[];
}

export interface McpBridgeAddOptions extends ParsedMcpAddArgs {}

export interface McpBridgeStatus {
  server: string;
  agent: string;
  warnings: string[];
  support: {
    supported: boolean;
    mode: "bridge" | "disabled";
    adapter?: AgentMcpAdapter;
    reason?: string;
  };
  url?: string;
  env: {
    names: string[];
    missing: string[];
    ready: boolean;
  };
  provider: {
    name?: string;
    registryPresent: boolean;
    gatewayPresent: boolean | null;
    attached: boolean | null;
    credentialReady: boolean | null;
    detail?: string;
  };
  policy: {
    name?: string;
    registryPresent: boolean;
    gatewayPresent: boolean | null;
  };
  adapter: {
    registered: boolean | null;
    detail?: string;
  };
  addState?: "prepared" | "preflighted";
  addedAt?: string;
  updatedAt?: string;
}

export function isAgentMcpAdapter(value: unknown): value is AgentMcpAdapter {
  return value === "mcporter" || value === "hermes-config" || value === "deepagents-config";
}
