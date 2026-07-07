// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-level credential-resolution probe (#6379).
 *
 * Provider metadata can be fully healthy while the OpenShell gateway never
 * rewrites the `openshell:resolve:env:` placeholder on egress, so every agent
 * request fails with the literal placeholder as the bearer token (see
 * NVIDIA/OpenShell#2161). This probe sends the same MCP `initialize` request
 * an agent runtime would send — curl wrapped in the adapter runtime so the
 * generated `protocol: mcp` policy attributes it to the adapter's binary
 * ancestry — and classifies whether the placeholder was resolved on the wire.
 */

import type { AgentMcpAdapter } from "../../agent/defs";
import { shellQuote } from "../../core/shell-quote";
import type { McpBridgeEntry } from "../../state/registry";
import { authorizationValue } from "./mcp-bridge-adapter-status";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { resolvePersistedCredentialEnvForRedaction } from "./mcp-bridge-validation";
import { executeSandboxCommand, type SandboxCommandResult } from "./process-recovery";

export const MCP_PROBE_HTTP_MARKER = "NEMOCLAW_MCP_PROBE_HTTP_CODE=";
export const MCP_PROBE_EXIT_MARKER = "NEMOCLAW_MCP_PROBE_CURL_EXIT=";

// executeSandboxCommand enforces a 15s spawnSync timeout; keep the in-sandbox
// curl budget comfortably below it so a slow endpoint classifies as a probe
// timeout instead of an ambiguous SSH failure.
const PROBE_CURL_MAX_TIME_SECONDS = 8;
const PROBE_BODY_EXCERPT_BYTES = 300;

export interface CredentialResolutionProbe {
  /** true = placeholder resolved on the wire; false = literal placeholder rejected; null = indeterminate or skipped. */
  ok: boolean | null;
  httpStatus?: number;
  detail?: string;
}

// "initialize" is idempotent and the first method allowed by the generated
// protocol: mcp policy, so the probe never mutates MCP server state.
const MCP_INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "nemoclaw-mcp-credential-probe", version: "1.0.0" },
  },
});

/**
 * OpenShell binds the generated MCP policy to /proc/<pid>/exe and ancestors,
 * so the curl child must keep the adapter's runtime binary as an ancestor.
 * Same construction as the live E2E DNS-rebinding probe.
 */
function runtimeWrappedCommand(adapter: AgentMcpAdapter, quotedCurl: string): string {
  switch (adapter) {
    case "mcporter": {
      const runner =
        'const { spawnSync } = require("node:child_process"); const result = spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" }); process.exit(result.status ?? 1);';
      return `nemoclaw-start node -e ${shellQuote(runner)} ${quotedCurl}`;
    }
    case "hermes-config": {
      const runner =
        "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
      return `/opt/hermes/.venv/bin/python -c ${shellQuote(runner)} ${quotedCurl}`;
    }
    case "deepagents-config": {
      const runner =
        "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
      return `/opt/venv/bin/python3 -c ${shellQuote(runner)} ${quotedCurl}`;
    }
  }
}

export function buildCredentialResolutionProbeCommand(
  entry: Pick<McpBridgeEntry, "server" | "url" | "env">,
  adapter: AgentMcpAdapter,
): string | null {
  const authorization = authorizationValue(entry);
  if (!authorization) return null;
  const responsePath = `/tmp/nemoclaw-mcp-credential-probe-${entry.server}.body`;
  const curlArgs = [
    "curl",
    "-sS",
    "--max-time",
    String(PROBE_CURL_MAX_TIME_SECONDS),
    "-o",
    responsePath,
    "-w",
    `\\n${MCP_PROBE_HTTP_MARKER}%{http_code}\\n`,
    "-X",
    "POST",
    entry.url,
    "-H",
    "content-type: application/json",
    "-H",
    // mcporter itself synthesizes this accept header on every HTTP definition.
    "accept: application/json, text/event-stream",
    "-H",
    `authorization: ${authorization}`,
    "--data-binary",
    MCP_INITIALIZE_BODY,
  ];
  const quotedCurl = curlArgs.map(shellQuote).join(" ");
  const quotedResponsePath = shellQuote(responsePath);
  return [
    // SSH sessions can miss the sandbox proxy environment (#2704).
    "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh || true",
    `rm -f ${quotedResponsePath}`,
    runtimeWrappedCommand(adapter, quotedCurl),
    "rc=$?",
    `printf '\\n${MCP_PROBE_EXIT_MARKER}%s\\n' "$rc"`,
    `head -c ${PROBE_BODY_EXCERPT_BYTES} ${quotedResponsePath} 2>/dev/null | tr -d '\\r' || true`,
    `rm -f ${quotedResponsePath}`,
    // Always exit 0 so a nonzero SSH status unambiguously means transport
    // failure, never a probe outcome.
    "exit 0",
  ].join("\n");
}

function redactedProbeText(text: string, entry: Pick<McpBridgeEntry, "env">): string {
  const envValues = resolvePersistedCredentialEnvForRedaction(entry.env);
  return redactBridgeSecretsForDisplay(text, entry, envValues).trim();
}

export function classifyCredentialResolutionProbe(
  result: SandboxCommandResult | null,
  entry: Pick<McpBridgeEntry, "env">,
): CredentialResolutionProbe {
  if (result === null) return { ok: null, detail: "sandbox unreachable" };
  if (result.status !== 0) {
    const detail = redactedProbeText(result.stderr || result.stdout, entry);
    return { ok: null, detail: detail || "probe transport failed" };
  }
  const exitMatch = result.stdout.match(new RegExp(`^${MCP_PROBE_EXIT_MARKER}([0-9]+)$`, "m"));
  if (!exitMatch) {
    const detail = redactedProbeText(result.stderr || result.stdout, entry);
    return { ok: null, detail: detail || "probe output missing markers" };
  }
  const curlExit = Number(exitMatch[1]);
  if (curlExit === 0) {
    const httpMatch = result.stdout.match(new RegExp(`^${MCP_PROBE_HTTP_MARKER}([0-9]{3})$`, "m"));
    if (!httpMatch) return { ok: null, detail: "probe output missing HTTP status" };
    const httpStatus = Number(httpMatch[1]);
    if (httpStatus >= 200 && httpStatus < 300) return { ok: true, httpStatus };
    if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403) {
      const excerptStart = result.stdout.indexOf(exitMatch[0]) + exitMatch[0].length;
      const excerpt = redactedProbeText(result.stdout.slice(excerptStart), entry);
      return {
        ok: false,
        httpStatus,
        ...(excerpt ? { detail: excerpt } : {}),
      };
    }
    // 404/405/5xx: a successfully rewritten credential against a broken or
    // relocated endpoint must not be blamed on the host's placeholder rewrite.
    return {
      ok: null,
      httpStatus,
      detail: `endpoint returned HTTP ${httpStatus}; credential resolution could not be judged`,
    };
  }
  if (curlExit === 56 && /CONNECT tunnel failed,\s*response 403/i.test(result.stderr)) {
    return {
      ok: null,
      detail: "OpenShell denied the probe connection (CONNECT 403); check the generated MCP policy",
    };
  }
  if (curlExit === 28) {
    return { ok: null, detail: `probe timed out after ${PROBE_CURL_MAX_TIME_SECONDS}s` };
  }
  const detail = redactedProbeText(result.stderr || result.stdout, entry);
  return { ok: null, detail: detail || `probe curl exited ${curlExit}` };
}

export function credentialResolutionFailureWarning(
  envName: string | undefined,
  httpStatus: number | undefined,
): string {
  const placeholder = envName ? `openshell:resolve:env:${envName}` : "openshell:resolve:env:<KEY>";
  const received = httpStatus !== undefined ? `received HTTP ${httpStatus}` : "was rejected";
  return `OpenShell did not resolve the credential placeholder '${placeholder}' on the wire (a gateway-egress MCP initialize probe ${received}). Agent runtimes take this same path, receive the same auth failure, and will skip this MCP server. Verify the OpenShell installation on this host (see NVIDIA/OpenShell issue 2161).`;
}

export function probeCredentialResolution(
  sandboxName: string,
  entry: McpBridgeEntry,
  adapter: AgentMcpAdapter | undefined,
): CredentialResolutionProbe {
  if (!adapter) return { ok: null, detail: "MCP adapter is not declared" };
  if (entry.addState) return { ok: null, detail: "add transaction incomplete" };
  const command = buildCredentialResolutionProbeCommand(entry, adapter);
  if (!command) return { ok: null, detail: "no credential binding to probe" };
  const result = executeSandboxCommand(sandboxName, command);
  return classifyCredentialResolutionProbe(result, entry);
}
