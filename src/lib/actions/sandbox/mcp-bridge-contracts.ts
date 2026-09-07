// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";

export const MCP_BRIDGE_POLICY_SOURCE = "generated:nemoclaw-mcp-bridge";
export type McpBridgeErrorReasonCode = "rejected" | "unresolved";
export class McpBridgeError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly reasonCode?: McpBridgeErrorReasonCode,
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
  trustedPrivateHosts?: string[];
}

/**
 * One MCP registration observed from an agent or assembled for a single
 * command. This is deliberately not a registry type: completed MCP commands
 * must leave no durable NemoClaw copy of agent or OpenShell state.
 */
export interface McpSourceEntry {
  server: string;
  agent: string;
  adapter?: string;
  url: string;
  env: string[];
  trustedPrivateHost?: string;
  allowedIps?: string[];
  providerName?: string;
  providerId?: string;
  policyName: string;
  /** Where the current agent registration was observed. */
  source?: "native" | "legacy" | "legacy-registry" | "policy";
  /** Live policy endpoint differs from the agent-native URL. */
  policyConflict?: string;
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
  trustedPrivateTarget?: {
    host: string;
    recordedPins: string[];
    currentPins?: string[];
    state: "match" | "drift" | "unresolved";
    detail?: string;
  };
  env: {
    names: string[];
    missing: string[];
    ready: boolean;
  };
  provider: {
    name?: string;
    present: boolean | null;
    attached: boolean | null;
    credentialReady: boolean | null;
    state: "configured" | "unbound" | "unavailable" | "conflict" | "orphaned";
    detail?: string;
    /**
     * Wire-level placeholder-resolution probe outcome (#6379). Present only
     * when the probe was requested for this entry; `ok: null` with a detail
     * means the probe ran or was skipped without a verdict.
     */
    credentialResolution?: {
      ok: boolean | null;
      httpStatus?: number;
      controlHttpStatus?: number;
      detail?: string;
    };
  };
  policy: {
    name?: string;
    present: boolean | null;
    state: "configured" | "blocked" | "unavailable" | "conflict" | "orphaned";
    detail?: string;
  };
  adapter: {
    registered: boolean | null;
    detail?: string;
  };
  /** Names advertised by the MCP endpoint when live discovery is requested. */
  toolDiscovery?: {
    ok: boolean;
    count: number;
    tools: string[];
    truncated: boolean;
    detail?: string;
  };
}

export function isAgentMcpAdapter(value: unknown): value is AgentMcpAdapter {
  return value === "openclaw-config" || value === "hermes-config" || value === "deepagents-config";
}
