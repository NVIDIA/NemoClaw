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
// to its supervisor. The sandbox-side prevention (gateway.reload.mode=off pin
// and the serving watchdog) ships separately in the #4710 sandbox PR.
// Removal condition: when sandbox images pin an OpenClaw release whose failed
// in-process restart exits non-zero (so the PID-wait supervisor respawns it),
// this detection can be narrowed and the recovery settle window shortened or
// defaulted off.

import type { OpenShellGatewayTarget } from "../../adapters/openshell/sandbox-observer";
import { cliOpenShellSandboxLogs } from "../../adapters/openshell/sandbox-logs-cli";
import type { OpenShellSandboxLogs } from "../../adapters/openshell/sandbox-logs";
import { shellQuote } from "../../runner";
import { redactFull, redactFullWithUrls } from "../../security/redact";
import { isCredentialField } from "../../security/credential-filter";
import type { SandboxCommandResult } from "./process-recovery";

export type SandboxExec = (
  sandboxName: string,
  command: string,
) => Promise<SandboxCommandResult | null>;

const WEDGE_LOG_SIGNATURE =
  "config change requires gateway restart|gateway startup failed|Process will stay alive";

/** Read startup logs before the restore caller stops the failed sandbox. */
export function buildOpenClawRestoreLogCommand(): string {
  const reader = String.raw`
import os, re, stat

directory = os.open('/tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    for name in ('nemoclaw-start.log', 'gateway.log'):
        fd = None
        print('[restore-log] ' + name, flush=True)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid():
                raise ValueError('unsafe log')
            # Inspect bounded complete context before selecting the output tail.
            # Otherwise a tail can start inside a multiline private key.
            if before.st_size > 1048576:
                raise ValueError('log too large')
            with os.fdopen(os.dup(fd), 'rb') as stream:
                data = stream.read(1048577)
            if len(data) > 1048576:
                raise ValueError('log too large')
            after = os.fstat(fd)
            if (before.st_dev, before.st_ino, before.st_uid, before.st_mode, before.st_nlink) != (after.st_dev, after.st_ino, after.st_uid, after.st_mode, after.st_nlink):
                raise ValueError('log changed')
            text = data.decode('utf-8', errors='replace')
            text = re.sub(r'-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|\Z)', '<REDACTED>', text)
            # A rotated log may itself begin midway through a private key.
            text = re.sub(r'\A[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----', '<REDACTED>', text)
            data = text.encode('utf-8')
            start = max(0, len(data) - 16384)
            text = data[start:].decode('utf-8', errors='replace')
            # Drop a partial first line rather than exposing a truncated credential.
            if start:
                text = text.partition('\n')[2]
            print(text, flush=True)
        except (OSError, ValueError):
            print('[restore-log] unavailable', flush=True)
        finally:
            if fd is not None:
                os.close(fd)
finally:
    os.close(directory)
`;
  return `/usr/bin/python3 -I -S -c ${shellQuote(reader)}`;
}

/** Keep failed reads visible without allowing diagnostics to replace recovery. */
export function formatOpenClawRestoreLogs(
  result: SandboxCommandResult | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!result) return ["[restore-log] command unavailable"];
  if (result.stdout.length > 64 * 1024 || result.stderr.length > 64 * 1024) {
    return ["[restore-log] output limit exceeded"];
  }
  let text = `${result.stdout}\n${result.stderr}`;
  // Known opaque credentials need value redaction as well as pattern redaction.
  for (const [key, value] of Object.entries(env)) {
    if (!value || !isCredentialField(key)) continue;
    // A bounded tail can omit earlier lines of an opaque multiline credential.
    const values = [value, ...value.split(/\r\n?|\n/u)];
    const representations = values.flatMap((part) => [part, JSON.stringify(part).slice(1, -1)]);
    for (const representation of new Set(representations)) {
      if (representation) text = text.replaceAll(representation, "<REDACTED>");
    }
  }
  text = redactFullWithUrls(text);
  const lines = text.split("\n").map(sanitizeWedgeLogLine).filter(Boolean);
  const bounded = lines.slice(-120).map((line) => line.slice(0, 480));
  return [
    `[restore-log] command exit ${String(result.status)}`,
    ...bounded,
    ...(bounded.length === 0 ? ["[restore-log] no output"] : []),
  ];
}

// The matched lines come from a sandbox-writable log, so they are untrusted:
// strip terminal control characters (no escape-sequence forgery in operator
// terminals) and redact common credential shapes before printing.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");
// These wedge-specific patterns run after redactFull. The `nvapi-\S+`
// catch-all is unbounded where the shared one requires ten or more characters.
const AUTHORIZATION_PATTERN = /\b(authorization\s*:\s*bearer)\s+\S+/gi;
const NVAPI_PATTERN = /\bnvapi-\S+/gi;

export function sanitizeWedgeLogLine(line: string): string {
  let sanitized = line.replace(CONTROL_CHARS_RE, (char) => (char === "\r" ? char : ""));
  sanitized = redactFull(sanitized);
  sanitized = sanitized.replace(AUTHORIZATION_PATTERN, "$1 [REDACTED]");
  sanitized = sanitized.replace(NVAPI_PATTERN, "[REDACTED]");
  return sanitized.replace(/\r/g, "").trim();
}

/** Read a bounded, sanitized tail from OpenShell's retained sandbox log buffer. */
export async function collectRedactedOpenShellSandboxLogs(
  sandboxName: string,
  target: OpenShellGatewayTarget,
  logs: OpenShellSandboxLogs = cliOpenShellSandboxLogs,
): Promise<string[]> {
  try {
    const result = await logs.read({
      target,
      sandboxName,
      source: "openshell",
      lines: "120",
      since: null,
      timeoutMs: 15_000,
    });
    if (
      result.outcome.kind !== "completed" ||
      result.outcome.exitCode !== 0 ||
      !result.content.trim()
    ) {
      return [];
    }
    return result.content.split("\n").map(sanitizeWedgeLogLine).filter(Boolean).slice(-60);
  } catch {
    return [];
  }
}

/**
 * Collect the #4710 wedge signature from the sandbox gateway log: the
 * sequence a self-initiated in-process gateway restart leaves behind when it
 * closes the HTTP listener and then fails, parking the process alive.
 * Returns up to the last five matching lines (sanitized), or [] when none
 * match or the log cannot be read.
 */
export async function collectGatewayWedgeDiagnostics(
  sandboxName: string,
  exec: SandboxExec,
): Promise<string[]> {
  const command = `grep -E ${shellQuote(WEDGE_LOG_SIGNATURE)} /tmp/gateway.log 2>/dev/null | tail -5`;
  let result: SandboxCommandResult | null;
  try {
    result = await exec(sandboxName, command);
  } catch {
    return [];
  }
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
export async function printGatewayWedgeDiagnostics(
  sandboxName: string,
  exec: SandboxExec,
): Promise<boolean> {
  const wedgeLines = await collectGatewayWedgeDiagnostics(sandboxName, exec);
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
