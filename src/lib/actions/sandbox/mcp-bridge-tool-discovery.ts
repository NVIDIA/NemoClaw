// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { shellQuote } from "../../core/shell-quote";
import type { McpBridgeEntry } from "../../state/registry";
import type { McpBridgeStatus } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import type { CredentialResolutionProbeReadiness } from "./mcp-bridge-resolution-readiness";
import {
  MCP_RUNTIME_SANITIZED_ENV_VARS,
  wrapMcpRuntimeCommand,
} from "./mcp-bridge-runtime-command";
import { normalizeMcpServerUrl } from "./mcp-bridge-validation";
import { executeSandboxCommand, type SandboxCommandResult } from "./process-recovery";
import {
  buildSandboxExecMarkedCommand,
  createSandboxExecMarker,
  extractSandboxExecCommandStdoutFromStreams,
} from "./sandbox-exec-output";
import { buildTrustedProxyEnvSourceShell } from "./trusted-proxy-env";

export const MCP_TOOL_DISCOVERY_RUNTIME_PATH =
  "/usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/mcp-tool-discovery.mjs";
export const MCP_TOOL_DISCOVERY_RESULT_PROTOCOL = 1;
export const MCP_TOOL_DISCOVERY_MAX_TOOLS = 500;
export const MCP_TOOL_DISCOVERY_MAX_NAME_BYTES = 256;
const MCP_TOOL_DISCOVERY_MAX_DETAIL_BYTES = 512;
// The compact runtime result may JSON-escape every byte in 500 valid 256-byte
// tool names. Keep that worst case inside the host boundary while retaining a
// strict cap on sandbox output.
const MCP_TOOL_DISCOVERY_MAX_OUTPUT_BYTES = 256 * 1_024;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

export type McpToolDiscoveryReadiness = CredentialResolutionProbeReadiness;

export interface McpToolDiscoveryCommand {
  command: string;
  resultMarker: string;
}

function failure(detail: string): NonNullable<McpBridgeStatus["toolDiscovery"]> {
  return { ok: false, count: 0, tools: [], truncated: false, detail };
}

export function toolDiscoveryReadinessSkipDetail(
  readiness: McpToolDiscoveryReadiness,
): string | undefined {
  if (readiness.policyGatewayPresent === null) {
    return "tool discovery skipped: the effective generated MCP policy could not be inspected";
  }
  if (!readiness.policyGatewayPresent) {
    return "tool discovery skipped: the generated MCP policy does not match the effective gateway policy";
  }
  if (readiness.providerAttached === null) {
    return "tool discovery skipped: provider attachment could not be inspected";
  }
  if (!readiness.providerAttached) {
    return "tool discovery skipped: the credential provider is not attached to the sandbox";
  }
  if (!readiness.providerCredentialReady) {
    return "tool discovery skipped: the OpenShell provider is absent or does not match the recorded credential binding";
  }
  return undefined;
}

export function buildMcpToolDiscoveryCommand(
  entry: Pick<McpBridgeEntry, "server" | "url" | "env">,
  adapter: AgentMcpAdapter,
): McpToolDiscoveryCommand | null {
  const credentialEnv = entry.env[0];
  if (!credentialEnv) return null;
  // The runtime receives only the validated provider key name. It reads the
  // current revisioned OpenShell placeholder from its fresh process environment
  // and rejects anything else before a request crosses the policy boundary.
  // Under the approved trusted-configured-endpoint contract, advertised names
  // remain untrusted and bounded display text, but may be credential-derived;
  // parser validation is not a confidentiality proof for a malicious server.
  try {
    if (normalizeMcpServerUrl(entry.url) !== entry.url) return null;
  } catch {
    return null;
  }

  const resultMarker = createSandboxExecMarker();
  const missingRuntimeResult = JSON.stringify({
    protocol: MCP_TOOL_DISCOVERY_RESULT_PROTOCOL,
    ok: false,
    count: 0,
    tools: [],
    truncated: false,
    detail: "sandbox image does not include the MCP tool discovery runtime; rebuild the sandbox",
  });
  const runtimeCommand = wrapMcpRuntimeCommand(adapter, [
    "/usr/local/bin/node",
    MCP_TOOL_DISCOVERY_RUNTIME_PATH,
    "--url",
    entry.url,
    "--credential-env",
    credentialEnv,
  ]);
  const body = [
    `if [ ! -r ${shellQuote(MCP_TOOL_DISCOVERY_RUNTIME_PATH)} ]; then`,
    `  printf '%s\\n' ${shellQuote(missingRuntimeResult)}`,
    "  exit 0",
    "fi",
    runtimeCommand,
  ].join("\n");

  return {
    resultMarker,
    command: [
      buildTrustedProxyEnvSourceShell(),
      `unset ${MCP_RUNTIME_SANITIZED_ENV_VARS.join(" ")} || true`,
      buildSandboxExecMarkedCommand(body, resultMarker),
    ].join("\n"),
  };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8Bytes(value) <= maxBytes && !UNSAFE_TEXT.test(value);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function classifyMcpToolDiscoveryResult(
  result: SandboxCommandResult | null,
  entry: Pick<McpBridgeEntry, "env">,
  resultMarker: string,
): NonNullable<McpBridgeStatus["toolDiscovery"]> {
  if (result === null) return failure("sandbox unreachable");
  if (result.status !== 0) {
    const safeFailure = `${result.stderr}\n${result.stdout}`
      .split(/\r?\n/u)
      .filter((line) => /^(?:\[SECURITY\] |Managed startup )/u.test(line))
      .map((line) => redactBridgeSecretsForDisplay(line, entry))
      .reverse()
      .find((line) => safeString(line, MCP_TOOL_DISCOVERY_MAX_DETAIL_BYTES));
    return failure(
      `MCP tool discovery runtime failed to start (exit ${String(result.status)})${safeFailure ? `: ${safeFailure}` : ""}; rebuild the sandbox if the image predates this diagnostic`,
    );
  }
  const output = extractSandboxExecCommandStdoutFromStreams(
    { stdout: result.stdout, stderr: result.stderr },
    resultMarker,
  );
  if (output === null) return failure("tool discovery output missing trusted result frame");
  if (utf8Bytes(output) > MCP_TOOL_DISCOVERY_MAX_OUTPUT_BYTES) {
    return failure("tool discovery returned an oversized result");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return failure("tool discovery returned an invalid result");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure("tool discovery returned an invalid result");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.protocol !== MCP_TOOL_DISCOVERY_RESULT_PROTOCOL ||
    typeof value.ok !== "boolean" ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    !Array.isArray(value.tools) ||
    value.tools.length !== value.count ||
    value.tools.length > MCP_TOOL_DISCOVERY_MAX_TOOLS ||
    typeof value.truncated !== "boolean"
  ) {
    return failure("tool discovery returned an invalid result");
  }

  const tools: string[] = [];
  const seen = new Set<string>();
  for (const tool of value.tools) {
    if (
      !safeString(tool, MCP_TOOL_DISCOVERY_MAX_NAME_BYTES) ||
      tool.length === 0 ||
      seen.has(tool)
    ) {
      return failure("tool discovery returned an invalid tool name");
    }
    seen.add(tool);
    tools.push(tool);
  }
  const sortedTools = [...tools].sort(compareNames);
  if (tools.some((tool, index) => tool !== sortedTools[index])) {
    return failure("tool discovery returned a non-deterministic tool inventory");
  }

  const detail = value.detail;
  if (detail !== undefined && !safeString(detail, MCP_TOOL_DISCOVERY_MAX_DETAIL_BYTES)) {
    return failure("tool discovery returned an invalid detail");
  }
  if ((value.ok && value.truncated) || (!value.ok && !detail)) {
    return failure("tool discovery returned an inconsistent result");
  }
  if (!value.ok && !value.truncated && tools.length > 0) {
    return failure("tool discovery returned an inconsistent partial result");
  }

  const redactedDetail = detail ? redactBridgeSecretsForDisplay(detail, entry) : undefined;
  if (redactedDetail && utf8Bytes(redactedDetail) > MCP_TOOL_DISCOVERY_MAX_DETAIL_BYTES) {
    return failure("tool discovery returned an oversized detail after redaction");
  }
  return {
    ok: value.ok,
    count: tools.length,
    tools,
    truncated: value.truncated,
    ...(redactedDetail ? { detail: redactedDetail } : {}),
  };
}

export function discoverMcpTools(
  sandboxName: string,
  entry: McpBridgeEntry,
  adapter: AgentMcpAdapter | undefined,
  readiness: McpToolDiscoveryReadiness,
): NonNullable<McpBridgeStatus["toolDiscovery"]> {
  if (!adapter) return failure("tool discovery skipped: MCP adapter is not declared");
  if (entry.addState) return failure("tool discovery skipped: add transaction is incomplete");
  const readinessSkipDetail = toolDiscoveryReadinessSkipDetail(readiness);
  if (readinessSkipDetail) return failure(readinessSkipDetail);
  const discoveryCommand = buildMcpToolDiscoveryCommand(entry, adapter);
  if (!discoveryCommand) {
    return failure("tool discovery skipped: no valid managed endpoint is available");
  }
  return classifyMcpToolDiscoveryResult(
    executeSandboxCommand(sandboxName, discoveryCommand.command),
    entry,
    discoveryCommand.resultMarker,
  );
}
