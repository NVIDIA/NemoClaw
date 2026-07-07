// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-level credential-resolution probe (#6379).
 *
 * Provider metadata can be fully healthy while the OpenShell gateway never
 * rewrites the `openshell:resolve:env:` placeholder on egress, so every agent
 * request fails with the literal placeholder as the bearer token (see
 * NVIDIA/OpenShell#2161).
 *
 * The probe is differential: it sends the same idempotent MCP `initialize`
 * request twice from inside the sandbox — once with the placeholder
 * authorization header exactly as agent traffic carries it, and once with a
 * deliberately-unresolvable literal control bearer that no gateway rewrite can
 * ever touch. A working rewrite makes the two requests reach the endpoint with
 * different bearers; a dead rewrite forwards both literally. Comparing only
 * the two HTTP status codes therefore distinguishes "placeholder resolved" from
 * "placeholder forwarded verbatim" without misblaming an expired or revoked
 * credential (which resolves correctly and then fails upstream auth).
 *
 * Response bodies are never captured or printed: they are untrusted
 * authenticated endpoint output, and redaction cannot be guaranteed once the
 * credential's host environment variable is absent. Classification uses HTTP
 * status codes and curl exit codes only.
 *
 * Probing is gated on the stored URL still satisfying the current
 * authenticated-endpoint boundary, so a persisted legacy, private-alias, or
 * plain-HTTP URL is never sent a header that the gateway could rewrite into a
 * live credential.
 */

import type { AgentMcpAdapter } from "../../agent/defs";
import { shellQuote } from "../../core/shell-quote";
import type { McpBridgeEntry } from "../../state/registry";
import { authorizationValue } from "./mcp-bridge-adapter-status";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { normalizeMcpServerUrl } from "./mcp-bridge-validation";
import { executeSandboxCommand, type SandboxCommandResult } from "./process-recovery";

export const MCP_PROBE_HTTP_MARKER = "NEMOCLAW_MCP_PROBE_HTTP_CODE=";
export const MCP_PROBE_EXIT_MARKER = "NEMOCLAW_MCP_PROBE_CURL_EXIT=";
export const MCP_PROBE_CONTROL_HTTP_MARKER = "NEMOCLAW_MCP_CONTROL_HTTP_CODE=";
export const MCP_PROBE_CONTROL_EXIT_MARKER = "NEMOCLAW_MCP_CONTROL_CURL_EXIT=";

/**
 * Literal control bearer. Not an `openshell:resolve:` reference, so the
 * gateway forwards it untouched on healthy and broken hosts alike, and it is
 * not a secret. It only has to be a value no endpoint would ever accept.
 */
export const MCP_PROBE_CONTROL_BEARER = "nemoclaw-mcp-probe-control-unresolvable";

// executeSandboxCommand enforces a 15s spawnSync timeout; two sequential curls
// must both fit comfortably below it so a slow endpoint classifies as a probe
// timeout instead of an ambiguous SSH failure.
const PROBE_CURL_MAX_TIME_SECONDS = 6;

export interface CredentialResolutionProbe {
  /** true = placeholder resolved on the wire; false = placeholder forwarded verbatim; null = indeterminate or skipped. */
  ok: boolean | null;
  httpStatus?: number;
  controlHttpStatus?: number;
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

function quotedCurlCommand(url: string, authorization: string, httpMarker: string): string {
  const curlArgs = [
    "curl",
    "-sS",
    "--max-time",
    String(PROBE_CURL_MAX_TIME_SECONDS),
    // The response body is untrusted authenticated endpoint output and is
    // never captured; classification uses status and exit codes only.
    "-o",
    "/dev/null",
    "-w",
    `\\n${httpMarker}%{http_code}\\n`,
    "-X",
    "POST",
    url,
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
  return curlArgs.map(shellQuote).join(" ");
}

export function buildCredentialResolutionProbeCommand(
  entry: Pick<McpBridgeEntry, "server" | "url" | "env">,
  adapter: AgentMcpAdapter,
): string | null {
  const authorization = authorizationValue(entry);
  if (!authorization) return null;
  // Never probe a persisted URL that no longer satisfies the current
  // authenticated-endpoint boundary: the gateway could rewrite the placeholder
  // header into a live credential bound for a legacy or private endpoint.
  try {
    if (normalizeMcpServerUrl(entry.url) !== entry.url) return null;
  } catch {
    return null;
  }
  const placeholderCurl = quotedCurlCommand(entry.url, authorization, MCP_PROBE_HTTP_MARKER);
  const controlCurl = quotedCurlCommand(
    entry.url,
    `Bearer ${MCP_PROBE_CONTROL_BEARER}`,
    MCP_PROBE_CONTROL_HTTP_MARKER,
  );
  return [
    // SSH sessions can miss the sandbox proxy environment (#2704).
    "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh || true",
    runtimeWrappedCommand(adapter, placeholderCurl),
    "rc=$?",
    `printf '\\n${MCP_PROBE_EXIT_MARKER}%s\\n' "$rc"`,
    runtimeWrappedCommand(adapter, controlCurl),
    "crc=$?",
    `printf '\\n${MCP_PROBE_CONTROL_EXIT_MARKER}%s\\n' "$crc"`,
    // Always exit 0 so a nonzero SSH status unambiguously means transport
    // failure, never a probe outcome.
    "exit 0",
  ].join("\n");
}

function redactedProbeText(text: string, entry: Pick<McpBridgeEntry, "env">): string {
  return redactBridgeSecretsForDisplay(text, entry).trim();
}

function markerValue(stdout: string, marker: string): number | undefined {
  const match = stdout.match(new RegExp(`^${marker}([0-9]+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

function transportDetail(curlExit: number, stderr: string): string | undefined {
  if (curlExit === 56 && /CONNECT tunnel failed,\s*response 403/i.test(stderr)) {
    return "OpenShell denied the probe connection (CONNECT 403); check the generated MCP policy";
  }
  if (curlExit === 28) return `probe timed out after ${PROBE_CURL_MAX_TIME_SECONDS}s`;
  return undefined;
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
  const placeholderExit = markerValue(result.stdout, MCP_PROBE_EXIT_MARKER);
  if (placeholderExit === undefined) {
    const detail = redactedProbeText(result.stderr || result.stdout, entry);
    return { ok: null, detail: detail || "probe output missing markers" };
  }
  if (placeholderExit !== 0) {
    const detail = transportDetail(placeholderExit, result.stderr);
    return { ok: null, detail: detail ?? `probe curl exited ${placeholderExit}` };
  }
  const httpStatus = markerValue(result.stdout, MCP_PROBE_HTTP_MARKER);
  if (httpStatus === undefined) return { ok: null, detail: "probe output missing HTTP status" };
  const controlExit = markerValue(result.stdout, MCP_PROBE_CONTROL_EXIT_MARKER);
  const controlHttpStatus =
    controlExit === 0 ? markerValue(result.stdout, MCP_PROBE_CONTROL_HTTP_MARKER) : undefined;
  if (controlHttpStatus === undefined) {
    return {
      ok: null,
      httpStatus,
      detail: `the placeholder probe received HTTP ${httpStatus} but the unresolvable control probe failed, so resolved and unresolved credentials cannot be distinguished`,
    };
  }
  const shared = { httpStatus, controlHttpStatus };
  if (httpStatus >= 200 && httpStatus < 300) {
    if (controlHttpStatus >= 200 && controlHttpStatus < 300) {
      return {
        ok: null,
        ...shared,
        detail: `the endpoint accepted both the placeholder probe and an unresolvable control bearer (HTTP ${httpStatus} / ${controlHttpStatus}), so it does not enforce authentication and credential resolution cannot be judged`,
      };
    }
    return { ok: true, ...shared };
  }
  if (httpStatus === controlHttpStatus) {
    return { ok: false, ...shared };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      ok: true,
      ...shared,
      detail: `the placeholder resolved on the wire (HTTP ${httpStatus} differs from the unresolvable control's HTTP ${controlHttpStatus}) but the endpoint rejected the credential — verify the stored credential value`,
    };
  }
  return {
    ok: null,
    ...shared,
    detail: `the placeholder probe received HTTP ${httpStatus} and the unresolvable control HTTP ${controlHttpStatus}; the difference does not prove resolution — compare against a known-good host`,
  };
}

export function credentialResolutionFailureWarning(
  envName: string | undefined,
  probe: Pick<CredentialResolutionProbe, "httpStatus" | "controlHttpStatus">,
): string {
  const placeholder = envName ? `openshell:resolve:env:${envName}` : "openshell:resolve:env:<KEY>";
  const evidence =
    probe.httpStatus !== undefined
      ? `the endpoint answered a placeholder-bearing MCP initialize probe and a deliberately-unresolvable control probe identically (HTTP ${probe.httpStatus})`
      : "a gateway-egress MCP initialize probe was rejected";
  return `OpenShell did not resolve the credential placeholder '${placeholder}' on the wire: ${evidence}. Agent runtimes take this same path, receive the same auth failure, and will skip this MCP server. Verify the OpenShell installation on this host (see NVIDIA/OpenShell issue 2161).`;
}

export function probeCredentialResolution(
  sandboxName: string,
  entry: McpBridgeEntry,
  adapter: AgentMcpAdapter | undefined,
): CredentialResolutionProbe {
  if (!adapter) return { ok: null, detail: "MCP adapter is not declared" };
  if (entry.addState) return { ok: null, detail: "add transaction incomplete" };
  const command = buildCredentialResolutionProbeCommand(entry, adapter);
  if (!command) return { ok: null, detail: "no credential binding or safe endpoint to probe" };
  const result = executeSandboxCommand(sandboxName, command);
  return classifyCredentialResolutionProbe(result, entry);
}
