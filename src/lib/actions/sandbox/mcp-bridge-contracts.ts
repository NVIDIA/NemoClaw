// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";

export const MCP_BRIDGE_POLICY_SOURCE = "generated:nemoclaw-mcp-bridge";
export type McpBridgeErrorReasonCode = "rejected" | "unresolved" | "supply-chain";
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

export type McpTransport = "sse" | "stdio";

export interface McpServerIdentity {
  /** SHA-256 digest of the MCP server binary/image (e.g., "sha256:abc123...") */
  digest: string;
  /** Transport protocol used by the server */
  transport: McpTransport;
  /** When this identity was verified */
  verifiedAt: number;
  /** Optional: provenance attestation reference (SLSA, sigstore, etc.) */
  provenanceRef?: string;
}

export interface ParsedEnvReference {
  name: string;
  value?: string;
}

export interface ParsedMcpAddArgs {
  server: string;
  url: string;
  env: ParsedEnvReference[];
  denyTools?: string[];
  /** Explicitly allowed tools (deny-by-default when specified). If omitted, denyTools is used for explicit denials. */
  allowTools?: string[];
  trustedPrivateHosts?: string[];
  /** Pinned server identity digest for supply-chain verification (e.g., "sha256:abc123...") */
  serverIdentity?: string;
  /** Transport protocol (defaults to "sse" for HTTP URLs, "stdio" for local) */
  transport?: McpTransport;
  /** Require OAuth authentication for the MCP endpoint */
  requireOAuth?: boolean;
}

/**
 * One MCP registration observed from an agent or assembled for a single
 * command. This is deliberately not a registry type: completed MCP commands
 * must leave no durable NemoClaw copy of agent or OpenShell state.
 */
export interface McpSourceEntry {
  server: string;
  agent: string;
  adapter?: AgentMcpAdapter;
  url: string;
  env: string[];
  trustedPrivateHost?: string;
  allowedIps?: string[];
  providerName?: string;
  providerId?: string;
  policyName: string;
  /** Denied tool selectors observed from the live OpenShell policy. */
  denyTools?: string[];
  /** Explicitly allowed tool selectors (deny-by-default mode). When present, only these tools are permitted. */
  allowTools?: string[];
  /** Where the current agent registration was observed. */
  source?: "native" | "legacy" | "legacy-registry" | "policy";
  /** Live policy endpoint differs from the agent-native URL. */
  policyConflict?: string;
  /** Pinned server identity for supply-chain verification. */
  serverIdentity?: McpServerIdentity;
  /** Transport protocol used by the server. */
  transport?: McpTransport;
  /** Whether OAuth authentication is required for this server. */
  requireOAuth?: boolean;
}

export interface McpBridgeAddOptions extends ParsedMcpAddArgs {}

export type McpBridgeToolDiscoveryFailedStage =
  | "preflight"
  | "runtime"
  | "initialization"
  | "tool-discovery";
export type McpBridgeToolDiscoveryFailureClass =
  | "precondition"
  | "runtime"
  | "connection"
  | "authentication"
  | "protocol"
  | "tool-operation";

export interface McpBridgeToolDiscoveryResult {
  ok: boolean;
  count: number;
  tools: string[];
  truncated: boolean;
  commandStatus: number | null;
  detail?: string;
  failedStage?: McpBridgeToolDiscoveryFailedStage;
  failureClass?: McpBridgeToolDiscoveryFailureClass;
}

export type ParsedMcpUpdateArgs =
  | { server: string; denyTools: string[] }
  | { server: string; refreshPublicPins: true }
  | { server: string; allowTools: string[] }
  | { server: string; clearAllowTools: true };

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
  publicTarget?: {
    host: string;
    recordedPins: string[];
    currentPins?: string[];
    state: "match" | "drift" | "unresolved" | "rejected";
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
  toolDiscovery?: McpBridgeToolDiscoveryResult;
  /** Supply-chain verification status for the MCP server. */
  supplyChain?: {
    identity?: McpServerIdentity;
    verified: boolean;
    transport: McpTransport;
    oauthRequired: boolean;
    allowToolsMode: boolean;
  };
}

export function isAgentMcpAdapter(value: unknown): value is AgentMcpAdapter {
  return value === "openclaw-config" || value === "hermes-config" || value === "deepagents-config";
}
