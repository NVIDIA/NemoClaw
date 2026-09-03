// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { redactString } from "../fixtures/redaction.ts";

export const HERMES_MCP_HTTP_STATUS_MARKER = "NEMOCLAW_HERMES_MCP_HTTP_STATUS=";
export const HERMES_MCP_RESULT_TOKEN_MARKER = "NEMOCLAW_HERMES_MCP_RESULT_TOKEN=";
export const HERMES_MCP_FAILURE_CAPTURE_BYTES = 4_096;
export const HERMES_MCP_FAILURE_PREVIEW_CHARS = 1_024;
export const HERMES_MCP_RESPONSE_FILE_BYTES = 65_536;

export interface HermesMcpCommandResult {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function isHermesGatewayDrainingResponse(result: HermesMcpCommandResult): boolean {
  if (result.exitCode !== 0 || parseHttpStatus(result.stderr) !== 503) return false;
  try {
    const body = JSON.parse(result.stdout) as { error?: { code?: unknown } };
    return body.error?.code === "gateway_draining";
  } catch {
    return false;
  }
}

const FAILURE_BODY_EMITTER = [
  "import os, pathlib, sys",
  "raw = pathlib.Path(sys.argv[1]).read_bytes()",
  "secret = os.environ.get('API_SERVER_KEY', '').encode('utf-8')",
  "replacement = b'[REDACTED]' if len(secret) >= 10 else b'*' * len(secret)",
  "sys.stdout.buffer.write(raw.replace(secret, replacement) if secret else raw)",
].join("\n");

export function buildHermesMcpChatProbeScript(payload: string, resultToken: string): string {
  return [
    "set -eu",
    "umask 077",
    'response_file="$(mktemp /tmp/nemoclaw-hermes-mcp-chat.XXXXXX)"',
    "trap 'rm -f \"$response_file\"' EXIT",
    `set -- -sS --max-time 180 --max-filesize ${HERMES_MCP_RESPONSE_FILE_BYTES} -o "$response_file" -w '%{http_code}' http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json'`,
    'if [ -n "${API_SERVER_KEY:-}" ]; then set -- "$@" -H "Authorization: Bearer ${API_SERVER_KEY}"; fi',
    `emit_failure_body() { /usr/bin/python3 -I -S -c ${shellQuote(FAILURE_BODY_EMITTER)} "$response_file"; }`,
    "set +e",
    `status="$(curl "$@" --data-binary ${shellQuote(payload)})"`,
    "curl_rc=$?",
    "set -e",
    `printf '\\n${HERMES_MCP_HTTP_STATUS_MARKER}%s\\n' "$status" >&2`,
    'if [ "$curl_rc" -ne 0 ]; then exit "$curl_rc"; fi',
    `case "$status" in 2??) if grep -Fq -- ${shellQuote(resultToken)} "$response_file"; then printf '${HERMES_MCP_RESULT_TOKEN_MARKER}present\\n' >&2; else printf '${HERMES_MCP_RESULT_TOKEN_MARKER}missing\\n' >&2; emit_failure_body; fi ;; *) emit_failure_body ;; esac`,
  ].join("\n");
}

export function buildHermesMcpRuntimeDiagnosticsScript(): string {
  return [
    "set -eu",
    "set -a",
    "[ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env",
    "set +a",
    "{",
    'for log in /tmp/nemoclaw-start.log /tmp/gateway.log; do printf \'== %s ==\\n\' "$log"; tail -n 100 "$log" 2>&1 || true; done',
    "printf '%s\\n' '== permissions =='",
    "stat -c '%a %U:%G %n' /sandbox /sandbox/.hermes /sandbox/.hermes/logs 2>&1 || true",
    "printf '%s\\n' '== managed supervisor =='",
    "cat /run/nemoclaw/gateway-control/status 2>&1 || true",
    "printf '%s\\n' '== gateway identity =='",
    "cat /sandbox/.hermes/runtime/gateway.pid 2>&1 || true",
    `} | /usr/bin/python3 -I -S -c ${shellQuote(FAILURE_BODY_EMITTER)} /dev/stdin`,
  ].join("\n");
}

function sanitizedPreview(text: string, explicitValues: Iterable<string>): string {
  const sanitized = redactString(text, explicitValues)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim();
  if (!sanitized) return "<empty>";
  const characters = [...sanitized];
  if (characters.length <= HERMES_MCP_FAILURE_PREVIEW_CHARS) return sanitized;
  const suffix = "… [truncated]";
  return `${characters
    .slice(0, HERMES_MCP_FAILURE_PREVIEW_CHARS - [...suffix].length)
    .join("")}${suffix}`;
}

function parseHttpStatus(stderr: string): number | null {
  const escapedMarker = HERMES_MCP_HTTP_STATUS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...stderr.matchAll(new RegExp(`^${escapedMarker}([0-9]{3})$`, "gmu"))];
  if (matches.length !== 1) return null;
  return Number(matches[0]?.[1]);
}

function hasResultToken(stderr: string): boolean {
  const marker = `${HERMES_MCP_RESULT_TOKEN_MARKER}present`;
  return stderr.split(/\r?\n/u).filter((line) => line === marker).length === 1;
}

export function assertHermesMcpHttpResponse(
  result: HermesMcpCommandResult,
  explicitRedactionValues: Iterable<string>,
): void {
  const status = parseHttpStatus(result.stderr);
  if (result.exitCode !== 0) {
    const transport = result.signal
      ? `signal=${result.signal}`
      : `exit=${result.exitCode ?? "unknown"}`;
    const detail = sanitizedPreview([result.stdout, result.stderr].filter(Boolean).join("\n"), [
      ...explicitRedactionValues,
    ]);
    throw new Error(`Hermes real MCP tool call transport failed (${transport}): ${detail}`);
  }
  if (status === null) {
    throw new Error("Hermes real MCP tool call did not report exactly one HTTP status marker");
  }
  if (status < 200 || status >= 300) {
    const body = sanitizedPreview(result.stdout, explicitRedactionValues);
    throw new Error(
      `Hermes real MCP tool call failed: HTTP ${status}; redacted response body: ${body}`,
    );
  }
  if (!hasResultToken(result.stderr)) {
    const body = sanitizedPreview(result.stdout, explicitRedactionValues);
    throw new Error(
      `Hermes real MCP tool call response did not contain the fixture result token; redacted response body: ${body}`,
    );
  }
  if (result.stdout !== "") {
    throw new Error("Hermes real MCP tool call success path emitted response contents");
  }
}
