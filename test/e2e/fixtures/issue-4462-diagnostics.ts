// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxClient } from "./clients/sandbox.ts";
import type { CleanupRegistry } from "./cleanup.ts";

interface Issue4462FailureDiagnosticsOptions {
  env: NodeJS.ProcessEnv;
  redactionValues: readonly string[];
  sandboxName: string;
}

const PAIRING_LOG_PATHS = ["/tmp/auto-pair.log", "/tmp/gateway.log"] as const;

const PROJECT_PAIRING_DIAGNOSTICS_PROGRAM = String.raw`
"use strict";
const fs = require("node:fs");
const logPaths = process.argv.slice(1);
const MAX_LOG_BYTES = 384 * 1024;
const SAFE_STAGE_OUTCOMES = new Set([
  "request-creation:observed",
  "request-creation:waiting",
  "listing:failed",
  "validation:accepted",
  "validation:rejected",
  "approval:attempting",
  "approval:failed",
  "watcher-execution:failed",
]);
const SAFE_REASONS = new Set([
  "allowlisted-initial-cli",
  "allowlisted-request",
  "command-failed",
  "disallowed-scopes",
  "empty-output",
  "invalid-json",
  "invalid-response",
  "malformed-request-id",
  "malformed-scopes",
  "no-request",
  "not-allowlisted",
  "pairing-required",
  "timeout",
  "unknown-client",
]);

function readTail(logPath) {
  const fd = fs.openSync(logPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_LOG_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text.split(/\r?\n/).slice(-400).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

function readAvailableTail(logPath) {
  try {
    return readTail(logPath);
  } catch {
    return null;
  }
}

function projectAutoPair(text) {
  if (text === null) return { readable: false, events: [] };
  const events = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const stageMatch = line.match(/^\[auto-pair\] stage=(request-creation|listing|validation|approval|watcher-execution) (observed|waiting|failed|accepted|rejected|attempting)\b/);
    if (!stageMatch) continue;
    const stage = stageMatch[1];
    const outcome = stageMatch[2];
    if (!SAFE_STAGE_OUTCOMES.has(stage + ":" + outcome)) continue;
    const reasonMatch = line.match(/\breason=([a-z-]+)\b/);
    const reason = reasonMatch && SAFE_REASONS.has(reasonMatch[1]) ? reasonMatch[1] : undefined;
    const key = stage + ":" + outcome + ":" + (reason || "");
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(reason ? { stage, outcome, reason } : { stage, outcome });
    if (events.length >= 100) break;
  }
  return { readable: true, events };
}

function signalCount(text, pattern) {
  return text === null ? 0 : (text.match(pattern) || []).length;
}

function projectGateway(text) {
  return {
    readable: text !== null,
    signals: {
      pairingRequired: signalCount(text, /\bpairing required\b/gi),
      scopeUpgradePending: signalCount(text, /\bscope upgrade pending approval\b/gi),
      pairingApprovalDenied: signalCount(text, /\bdevice pairing approval denied\b/gi),
      gatewayUnavailable: signalCount(text, /\bgateway unavailable\b/gi),
    },
  };
}

try {
  if (logPaths.length !== 2) throw new Error("invalid diagnostics inputs");
  const autoPair = readAvailableTail(logPaths[0]);
  const gateway = readAvailableTail(logPaths[1]);
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    autoPair: projectAutoPair(autoPair),
    gateway: projectGateway(gateway),
  }) + "\n");
} catch {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, status: "unavailable" }) + "\n");
  process.exitCode = 1;
}
`;

export function buildIssue4462DiagnosticsCommand(
  logPaths: readonly string[] = PAIRING_LOG_PATHS,
): string[] {
  return ["node", "-e", PROJECT_PAIRING_DIAGNOSTICS_PROGRAM, ...logPaths];
}

/** Preserve startup pairing evidence without replacing the scenario's primary failure. */
export async function captureIssue4462FailureDiagnostics(
  sandbox: Pick<SandboxClient, "exec">,
  options: Issue4462FailureDiagnosticsOptions,
): Promise<void> {
  try {
    await sandbox.exec(options.sandboxName, buildIssue4462DiagnosticsCommand(), {
      artifactName: "failure-openclaw-pairing-diagnostics",
      captureLimitBytes: 1024 * 1024,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 30_000,
    });
  } catch {
    // Preserve the primary failure when the sandbox or its logs are unavailable.
  }
}

export function trackIssue4462FailureDiagnostics(
  cleanup: Pick<CleanupRegistry, "trackDisposable">,
  sandbox: Pick<SandboxClient, "exec">,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactionValues: readonly string[],
): void {
  cleanup.trackDisposable("capture OpenClaw pairing failure diagnostics", () =>
    captureIssue4462FailureDiagnostics(sandbox, { env, redactionValues, sandboxName }),
  );
}
