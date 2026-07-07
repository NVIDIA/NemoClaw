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
 * different bearers; a dead rewrite forwards both literally. Only a
 * placeholder 2xx paired with a rejected control verifies resolution — an
 * accepted request proves a valid credential was on the wire while the control
 * proves the endpoint rejects garbage. Every non-2xx placeholder outcome is
 * inconclusive with the hypotheses named: identical rejections cannot separate
 * "forwarded verbatim" from "resolved but expired or revoked", and differing
 * rejections cannot either, because an endpoint may reject two different
 * literal bearer strings differently.
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
 *
 * Source-boundary note:
 * - invalidState: provider metadata is healthy while OpenShell forwards the
 *   literal placeholder instead of resolving it.
 * - sourceBoundary: OpenShell owns provider attachment/rewrite behavior;
 *   NemoClaw owns this bounded diagnostic and its fail-closed prerequisites.
 * - whyNotSourceFix: supported OpenShell versions expose neither a
 *   resolution-or-deny guarantee nor an adequate machine-readable signal.
 * - regressionTest: mcp-bridge-resolution-probe.test.ts pins classification
 *   and central no-send gates; mcp-bridge-status-resolution.test.ts pins status
 *   and post-add policy/provider prerequisites.
 * - removalCondition: remove or replace this probe only when every supported
 *   OpenShell version guarantees resolution-or-deny before egress or exposes a
 *   reviewed signal for the exact attached provider revision and generated route.
 */

import type { AgentMcpAdapter } from "../../agent/defs";
import { shellQuote } from "../../core/shell-quote";
import type { McpBridgeEntry } from "../../state/registry";
import { authorizationValue } from "./mcp-bridge-adapter-status";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import {
  type CredentialResolutionProbeReadiness,
  credentialResolutionReadinessSkipDetail,
} from "./mcp-bridge-resolution-readiness";
import { normalizeMcpServerUrl } from "./mcp-bridge-validation";
import { executeSandboxCommand, type SandboxCommandResult } from "./process-recovery";
import {
  buildSandboxExecMarkedCommand,
  createSandboxExecMarker,
  extractSandboxExecCommandStdoutFromStreams,
} from "./sandbox-exec-output";
import { buildTrustedProxyEnvSourceShell } from "./trusted-proxy-env";

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

/**
 * Sourcing /tmp/nemoclaw-proxy-env.sh can export the OpenClaw gateway
 * credentials and break-glass toggles alongside the proxy variables the probe
 * actually needs. These are unset immediately after sourcing, before the
 * first child process, so neither the adapter runtime nor curl inherits them
 * (same sanitize set nemoclaw-start uses for un-managed openclaw children).
 */
export const PROBE_SANITIZED_ENV_VARS = [
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
  "NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
] as const;

export interface CredentialResolutionProbe {
  /**
   * true = placeholder resolved on the wire; null = inconclusive or skipped
   * (see detail). false is reserved for future evidence sources that can
   * prove non-rewriting; wire statuses alone never can, so the current
   * classifier never emits it.
   */
  ok: boolean | null;
  httpStatus?: number;
  controlHttpStatus?: number;
  detail?: string;
}

export interface CredentialResolutionProbeCommand {
  command: string;
  resultMarker: string;
}

interface ProbeOutputMarkers {
  controlExit: string;
  controlHttp: string;
  placeholderExit: string;
  placeholderHttp: string;
}

function probeOutputMarkers(resultMarker?: string): ProbeOutputMarkers {
  const nonce = resultMarker ? `${resultMarker}:` : "";
  return {
    placeholderHttp: `${MCP_PROBE_HTTP_MARKER}${nonce}`,
    placeholderExit: `${MCP_PROBE_EXIT_MARKER}${nonce}`,
    controlHttp: `${MCP_PROBE_CONTROL_HTTP_MARKER}${nonce}`,
    controlExit: `${MCP_PROBE_CONTROL_EXIT_MARKER}${nonce}`,
  };
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
): CredentialResolutionProbeCommand | null {
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
  const resultMarker = createSandboxExecMarker();
  const markers = probeOutputMarkers(resultMarker);
  const placeholderCurl = quotedCurlCommand(entry.url, authorization, markers.placeholderHttp);
  const controlCurl = quotedCurlCommand(
    entry.url,
    `Bearer ${MCP_PROBE_CONTROL_BEARER}`,
    markers.controlHttp,
  );
  const probeBody = [
    runtimeWrappedCommand(adapter, placeholderCurl),
    "rc=$?",
    `printf '\\n${markers.placeholderExit}%s\\n' "$rc"`,
    runtimeWrappedCommand(adapter, controlCurl),
    "crc=$?",
    `printf '\\n${markers.controlExit}%s\\n' "$crc"`,
    // Always exit 0 so a nonzero SSH status unambiguously means transport
    // failure, never a probe outcome.
    "exit 0",
  ].join("\n");
  return {
    resultMarker,
    command: [
      // SSH sessions can miss the sandbox proxy environment (#2704). Validate
      // the cross-user file and suppress source-time output before framing any
      // probe result, so preamble text cannot impersonate result markers.
      buildTrustedProxyEnvSourceShell(),
      // Must stay between the sourcing above and the first child below.
      `unset ${PROBE_SANITIZED_ENV_VARS.join(" ")} || true`,
      buildSandboxExecMarkedCommand(probeBody, resultMarker),
    ].join("\n"),
  };
}

function redactedProbeText(text: string, entry: Pick<McpBridgeEntry, "env">): string {
  return redactBridgeSecretsForDisplay(text, entry).trim();
}

interface ProbeMarkerValue {
  index: number;
  value: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerValue(stdout: string, marker: string): ProbeMarkerValue | undefined {
  const matches = [...stdout.matchAll(new RegExp(`^${escapeRegExp(marker)}([0-9]+)$`, "gm"))];
  if (matches.length !== 1) return undefined;
  return { index: matches[0].index, value: Number(matches[0][1]) };
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
  resultMarker?: string,
): CredentialResolutionProbe {
  if (result === null) return { ok: null, detail: "sandbox unreachable" };
  if (result.status !== 0) {
    const detail = redactedProbeText(result.stderr || result.stdout, entry);
    return { ok: null, detail: detail || "probe transport failed" };
  }
  const framedStdout = resultMarker
    ? extractSandboxExecCommandStdoutFromStreams(
        { stdout: result.stdout, stderr: result.stderr },
        resultMarker,
      )
    : result.stdout;
  if (framedStdout === null) {
    return { ok: null, detail: "probe output missing trusted result frame" };
  }
  const markers = probeOutputMarkers(resultMarker);
  const placeholderExit = markerValue(framedStdout, markers.placeholderExit);
  if (placeholderExit === undefined) {
    return { ok: null, detail: "probe output missing or ambiguous markers" };
  }
  if (placeholderExit.value !== 0) {
    const detail = transportDetail(placeholderExit.value, result.stderr);
    return { ok: null, detail: detail ?? `probe curl exited ${placeholderExit.value}` };
  }
  const httpStatus = markerValue(framedStdout, markers.placeholderHttp);
  if (httpStatus === undefined) return { ok: null, detail: "probe output missing HTTP status" };
  const controlExit = markerValue(framedStdout, markers.controlExit);
  const controlHttpStatus =
    controlExit?.value === 0 ? markerValue(framedStdout, markers.controlHttp) : undefined;
  if (controlExit === undefined || controlHttpStatus === undefined) {
    return {
      ok: null,
      httpStatus: httpStatus.value,
      detail: `the placeholder probe received HTTP ${httpStatus.value} but the unresolvable control probe failed, so resolved and unresolved credentials cannot be distinguished`,
    };
  }
  if (
    !(
      httpStatus.index < placeholderExit.index &&
      placeholderExit.index < controlHttpStatus.index &&
      controlHttpStatus.index < controlExit.index
    )
  ) {
    return { ok: null, detail: "probe output markers were out of order" };
  }
  const shared = {
    httpStatus: httpStatus.value,
    controlHttpStatus: controlHttpStatus.value,
  };
  if (httpStatus.value >= 200 && httpStatus.value < 300) {
    if (controlHttpStatus.value >= 200 && controlHttpStatus.value < 300) {
      return {
        ok: null,
        ...shared,
        detail: `the endpoint accepted both the placeholder probe and an unresolvable control bearer (HTTP ${httpStatus.value} / ${controlHttpStatus.value}), so it does not enforce authentication and credential resolution cannot be judged`,
      };
    }
    return { ok: true, ...shared };
  }
  if (httpStatus.value === controlHttpStatus.value) {
    // Identical statuses never prove non-rewriting: a correctly rewritten but
    // expired or revoked credential and the bogus control can both draw the
    // same 4xx, and an endpoint can fail both probes the same way. Report the
    // evidence and let the operator rule out the credential.
    if (httpStatus.value >= 400 && httpStatus.value < 500) {
      const validationHypothesis =
        httpStatus.value === 400
          ? ", or with an initialize request this endpoint does not accept (request validation)"
          : "";
      return {
        ok: null,
        ...shared,
        detail: `the placeholder probe and the unresolvable control probe were rejected identically (HTTP ${httpStatus.value}); this is consistent with the placeholder being forwarded verbatim, but also with an expired or revoked credential that resolved correctly${validationHypothesis} — verify the stored credential value first`,
      };
    }
    return {
      ok: null,
      ...shared,
      detail: `both probes received HTTP ${httpStatus.value}; the endpoint failed identically and credential resolution could not be judged`,
    };
  }
  // Differing non-2xx statuses prove nothing either: a broken gateway forwards
  // two different literal bearer strings, and an endpoint may reject those
  // differently (e.g. placeholder 401, control 400) without rewriting one of
  // them. Only a placeholder 2xx with a rejected control proves resolution.
  return {
    ok: null,
    ...shared,
    detail: `the placeholder probe received HTTP ${httpStatus.value} and the unresolvable control HTTP ${controlHttpStatus.value}; differing rejections do not prove resolution because the endpoint may reject two different literal bearers differently — verify the stored credential value and compare against a known-good host`,
  };
}

/**
 * Warning for the identical-4xx outcome. Wire evidence alone cannot separate
 * "placeholder forwarded verbatim" from "resolved but expired or revoked
 * credential", so the warning states the hypotheses and tells the operator
 * which check rules out which. For identical 401/403 a confirmed-valid
 * credential does settle it (a rewritten valid credential cannot draw the
 * same auth rejection as garbage); for identical 400 it does not, because the
 * endpoint may reject the probe's initialize request itself regardless of the
 * bearer, so that warning stays explicitly inconclusive.
 */
export function credentialResolutionWarning(
  envName: string | undefined,
  probe: Pick<CredentialResolutionProbe, "ok" | "httpStatus" | "controlHttpStatus">,
): string | undefined {
  if (probe.ok !== null) return undefined;
  if (probe.httpStatus === undefined || probe.httpStatus !== probe.controlHttpStatus)
    return undefined;
  if (probe.httpStatus < 400 || probe.httpStatus >= 500) return undefined;
  const placeholder = envName ? `openshell:resolve:env:${envName}` : "openshell:resolve:env:<KEY>";
  if (probe.httpStatus === 400) {
    return `Credential resolution could not be verified: a placeholder-bearing MCP initialize probe and a deliberately-unresolvable control probe were rejected identically (HTTP 400). This is inconclusive even with a valid stored credential — the endpoint may reject the probe's initialize request itself (request validation), the '${placeholder}' placeholder may have been forwarded verbatim, or the credential may be expired or revoked. Rotate the credential with mcp restart if in doubt, and compare mcp status for the same server on a known-good host; if that host verifies, suspect this host's OpenShell placeholder rewrite (see NVIDIA/OpenShell issue 2161).`;
  }
  if (probe.httpStatus !== 401 && probe.httpStatus !== 403) return undefined;
  return `Credential resolution could not be verified: a placeholder-bearing MCP initialize probe and a deliberately-unresolvable control probe were rejected identically (HTTP ${probe.httpStatus}). If the stored credential is confirmed valid, the OpenShell host is not rewriting the '${placeholder}' placeholder on egress and agent runtimes will hit the same auth failure and skip this MCP server (see NVIDIA/OpenShell issue 2161). Otherwise, rotate the credential with mcp restart and re-run mcp status.`;
}

export function probeCredentialResolution(
  sandboxName: string,
  entry: McpBridgeEntry,
  adapter: AgentMcpAdapter | undefined,
  readiness: CredentialResolutionProbeReadiness,
): CredentialResolutionProbe {
  if (!adapter) return { ok: null, detail: "MCP adapter is not declared" };
  if (entry.addState) return { ok: null, detail: "add transaction incomplete" };
  const probeCommand = buildCredentialResolutionProbeCommand(entry, adapter);
  if (!probeCommand) return { ok: null, detail: "no credential binding or safe endpoint to probe" };
  const readinessSkipDetail = credentialResolutionReadinessSkipDetail(readiness);
  if (readinessSkipDetail) return { ok: null, detail: readinessSkipDetail };
  const result = executeSandboxCommand(sandboxName, probeCommand.command);
  return classifyCredentialResolutionProbe(result, entry, probeCommand.resultMarker);
}
