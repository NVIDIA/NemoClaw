// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { McpBridgeError, type McpSourceEntry, type McpTransport } from "./mcp-bridge-contracts";

/**
 * Verify an MCP server's operator-provided identity pin against the stored pin.
 * This is an operator-managed pin (not an attested artifact verification).
 * It protects against accidental configuration drift but not supply-chain substitution.
 * For attested verification, use SLSA provenance or sigstore attestation separately.
 */
export async function verifyMcpServerIdentity(
  entry: McpSourceEntry,
  expectedIdentity?: string,
): Promise<void> {
  if (!expectedIdentity) return;

  if (!entry.serverIdentity) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' requires supply-chain verification (--server-identity) but no identity was recorded. Remove and re-add with --server-identity sha256:...`,
      2,
      "supply-chain",
    );
  }

  if (entry.serverIdentity.digest !== expectedIdentity) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' operator pin mismatch: expected ${expectedIdentity}, stored ${entry.serverIdentity.digest}. The server binary may have been replaced. Remove and re-add with the correct --server-identity.`,
      2,
      "supply-chain",
    );
  }

  // Verify the digest format
  if (!/^sha256:[a-f0-9]{64}$/.test(entry.serverIdentity.digest)) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has malformed identity digest: ${entry.serverIdentity.digest}. Expected format: sha256:<64-hex-chars>.`,
      2,
      "supply-chain",
    );
  }
}

/**
 * Enforce transport-specific trust policies.
 * SSE (HTTP-based) is preferred over STDIO for production use because:
 * - SSE allows OpenShell to enforce network policies and credential boundaries
 * - STDIO bypasses network enforcement and runs with full host access
 * - SSE supports OAuth and credential rotation
 */
export function enforceTransportTrust(entry: McpSourceEntry, requireOAuth: boolean): void {
  const transport = entry.transport ?? inferTransportFromUrl(entry.url);

  if (transport === "stdio") {
    if (requireOAuth) {
      throw new McpBridgeError(
        "STDIO transport does not support OAuth authentication. Use --transport sse with an HTTPS endpoint.",
        2,
        "supply-chain",
      );
    }
    // Warn but allow for backward compatibility with local development
    console.warn(
      `  WARNING: MCP server '${entry.server}' uses STDIO transport. This bypasses OpenShell network policies and credential boundaries. Prefer SSE (--transport sse) for production.`,
    );
  }

  // --require-oauth requires SSE transport; HTTPS is validated at the add action boundary.
  // OAuth exchange verification is NOT yet implemented at the credential boundary.
  // The --require-oauth flag is recorded for future enforcement at the provider boundary.
  if (requireOAuth && transport !== "sse") {
    throw new McpBridgeError(
      "--require-oauth requires SSE transport (--transport sse) with an HTTPS endpoint.",
      2,
      "supply-chain",
    );
  }
}

/**
 * Infer transport from URL scheme.
 * HTTPS/HTTP URLs default to SSE (Streamable HTTP).
 * Local/file URLs would use STDIO.
 */
export function inferTransportFromUrl(url: string): McpTransport {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") return "sse";
    return "stdio";
  } catch {
    return "stdio";
  }
}

/**
 * Compute the expected allow/deny tool policy for OpenShell.
 * When allowTools is specified, deny-by-default mode is enabled.
 */
export function computeToolPolicy(
  allowTools?: readonly string[],
  denyTools?: readonly string[],
): { allowTools: readonly string[]; denyTools: readonly string[]; mode: "allowlist" | "denylist" } {
  if (allowTools && allowTools.length > 0) {
    return {
      allowTools,
      denyTools: [],
      mode: "allowlist",
    };
  }
  return {
    allowTools: [],
    denyTools: denyTools ?? [],
    mode: "denylist",
  };
}

/**
 * Validate that the tool policy is compatible with the server's capabilities.
 * This is a placeholder for future live tool discovery integration.
 */

