// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// #4710 wedge diagnostics — source-of-truth contract:
//
// Invalid state: the in-sandbox OpenClaw gateway performs a self-initiated
// in-process restart on restart-class config changes; in containers a failed
// restart parks the process alive with its HTTP listener closed, logging
// "gateway startup failed: ... Process will stay alive; fix the issue and
// restart." to /tmp/gateway.log.
// Source boundary: that park-alive behavior lives in OpenClaw's gateway run
// loop, outside NemoClaw; NemoClaw can only detect it and hand recovery back
// to its supervisor. The sandbox-side prevention (gateway.reload.mode=hot pin
// and the serving watchdog) ships separately in the #4710 sandbox PR.
// Removal condition: when sandbox images pin an OpenClaw release whose failed
// in-process restart exits non-zero (so the PID-wait supervisor respawns it),
// this detection can be narrowed and the recovery settle window shortened or
// defaulted off.

import { shellQuote } from "../../runner";
import type { SandboxCommandResult } from "./process-recovery";

export type SandboxExec = (sandboxName: string, command: string) => SandboxCommandResult | null;

const WEDGE_LOG_SIGNATURE =
  "config change requires gateway restart|gateway startup failed|Process will stay alive";

// The matched lines come from a sandbox-writable log, so they are untrusted:
// strip terminal control characters (no escape-sequence forgery in operator
// terminals) and redact common credential shapes before printing.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");
const SECRET_PATTERNS: RegExp[] = [
  /\b(authorization\s*:\s*bearer)\s+\S+/gi,
  /\b(api[-_]?key|token|secret|password)(["']?\s*[=:]\s*["']?)\S+/gi,
  /\bnvapi-\S+/gi,
];

export function sanitizeWedgeLogLine(line: string): string {
  let sanitized = line.replace(CONTROL_CHARS_RE, "");
  sanitized = sanitized.replace(SECRET_PATTERNS[0], "$1 [REDACTED]");
  sanitized = sanitized.replace(SECRET_PATTERNS[1], "$1$2[REDACTED]");
  sanitized = sanitized.replace(SECRET_PATTERNS[2], "[REDACTED]");
  return sanitized.trim();
}

/**
 * Collect the #4710 wedge signature from the sandbox gateway log: the
 * sequence a self-initiated in-process gateway restart leaves behind when it
 * closes the HTTP listener and then fails, parking the process alive.
 * Returns up to the last five matching lines (sanitized), or [] when none
 * match or the log cannot be read.
 */
export function collectGatewayWedgeDiagnostics(sandboxName: string, exec: SandboxExec): string[] {
  const command = `grep -E ${shellQuote(WEDGE_LOG_SIGNATURE)} /tmp/gateway.log 2>/dev/null | tail -5`;
  const result = exec(sandboxName, command);
  if (!result || result.status !== 0) {
    return [];
  }
  return result.stdout.split("\n").map(sanitizeWedgeLogLine).filter(Boolean);
}

/**
 * Print the #4710 wedge signature (if present) to stderr so the operator
 * sees why the gateway is unreachable despite a live process. Returns true
 * when signature lines were found and printed.
 */
export function printGatewayWedgeDiagnostics(sandboxName: string, exec: SandboxExec): boolean {
  const wedgeLines = collectGatewayWedgeDiagnostics(sandboxName, exec);
  if (wedgeLines.length === 0) {
    return false;
  }
  console.error(
    "  The gateway served briefly and then dropped its HTTP listener (#4710 wedge signature):",
  );
  for (const line of wedgeLines) {
    console.error(`    ${line}`);
  }
  return true;
}
