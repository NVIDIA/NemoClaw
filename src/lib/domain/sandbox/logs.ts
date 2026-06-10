// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import type { SandboxLogsOptions } from "./log-options";
import { DEFAULT_SANDBOX_LOG_LINES } from "./log-options";

export const DEFAULT_LOGS_PROBE_TIMEOUT_MS = 5000;
export const LOGS_PROBE_TIMEOUT_ENV = "NEMOCLAW_LOGS_PROBE_TIMEOUT_MS";

export type LogProbeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};

export function getLogsProbeTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const rawValue = env[LOGS_PROBE_TIMEOUT_ENV];
  if (!rawValue) {
    return DEFAULT_LOGS_PROBE_TIMEOUT_MS;
  }
  const parsed = Number(rawValue);
  const timeoutMs = Number.isFinite(parsed) ? Math.floor(parsed) : Number.NaN;
  return timeoutMs > 0 ? timeoutMs : DEFAULT_LOGS_PROBE_TIMEOUT_MS;
}

export function describeLogProbeResult(result: LogProbeResult): string {
  if (result.error) {
    return result.error.message;
  }
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return `exit ${result.status ?? "unknown"}`;
}

export function exitCodeFromSignal(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signalNumber = os.constants.signals[signal];
  return signalNumber ? 128 + signalNumber : 1;
}

export function normalizeSandboxLogsOptions(
  options: SandboxLogsOptions | boolean,
): SandboxLogsOptions {
  if (typeof options === "boolean") {
    return { follow: options, lines: DEFAULT_SANDBOX_LOG_LINES, since: null };
  }
  return {
    follow: options.follow,
    lines: options.lines || DEFAULT_SANDBOX_LOG_LINES,
    since: options.since || null,
  };
}

export function buildEnableSandboxAuditLogsArgs(sandboxName: string): string[] {
  return ["settings", "set", sandboxName, "--key", "ocsf_json_enabled", "--value", "true"];
}

export function buildSandboxOpenclawGatewayLogsArgs(
  sandboxName: string,
  options: SandboxLogsOptions,
): string[] {
  const args = ["sandbox", "exec", "-n", sandboxName, "--", "tail", "-n", options.lines];
  if (options.follow) {
    args.push("-f");
  }
  args.push("/tmp/gateway.log");
  return args;
}

export function buildSandboxLogsArgs(sandboxName: string, options: SandboxLogsOptions): string[] {
  const args = ["logs", sandboxName, "-n", options.lines, "--source", "all"];
  if (options.since) {
    args.push("--since", options.since);
  }
  if (options.follow) {
    args.push("--tail");
  }
  return args;
}

// Tail-merge helpers (closes #4100)

const EPOCH_TIMESTAMP_RE = /^\[(\d+)(?:\.(\d+))?\]/;
const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/;
const LINE_SPLIT_RE = /\r?\n/;
const NEWLINE = "\n";

/**
 * Parse a leading timestamp from a NemoClaw log line. Returns
 * milliseconds since the Unix epoch, or null if no recognisable
 * timestamp is at the start of the line.
 *
 * Two formats are produced by the sources that showSandboxLogs
 * merges:
 *
 *   1. OpenShell sandbox audit: [1779488798.644] [sandbox] [OCSF ] ...
 *      (epoch seconds, optional fractional seconds, in brackets)
 *   2. Gateway log file: 2026-05-22T20:55:38.152+00:00 [gateway] ...
 *      (ISO 8601 with offset)
 */
export function parseLineTimestamp(line: string): number | null {
  const epoch = line.match(EPOCH_TIMESTAMP_RE);
  if (epoch) {
    const secs = Number(epoch[1]);
    if (!Number.isFinite(secs)) return null;
    const fracStr = (epoch[2] ?? "").padEnd(3, "0").slice(0, 3);
    const ms = Number(fracStr);
    if (!Number.isFinite(ms)) return secs * 1000;
    return secs * 1000 + ms;
  }
  const iso = line.match(ISO_TIMESTAMP_RE);
  if (iso) {
    const parsed = Date.parse(iso[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

interface ScoredLine {
  text: string;
  timestamp: number;
  sourceIndex: number;
  lineIndex: number;
}

/**
 * Merge log lines from multiple sources into a single chronologically
 * ordered stream and return the last maxLines lines as a single
 * string. Lines without their own timestamp inherit the timestamp of
 * the previous line from the same source so multi-line log entries
 * stay attached to their header. Sort is stable on
 * (timestamp, sourceIndex, lineIndex) so identically-timestamped
 * lines from different sources interleave deterministically.
 *
 * When maxLines is non-positive, all merged lines are returned.
 */
export function mergeTailLogLines(sources: ReadonlyArray<string>, maxLines: number): string {
  const scored: ScoredLine[] = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const raw = sources[sourceIndex] ?? "";
    if (!raw) continue;
    const lines = raw.split(LINE_SPLIT_RE);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    let lastSeen: number | null = null;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const text = lines[lineIndex];
      const parsed = parseLineTimestamp(text);
      if (parsed !== null) lastSeen = parsed;
      scored.push({
        text,
        timestamp: lastSeen ?? Number.MIN_SAFE_INTEGER,
        sourceIndex,
        lineIndex,
      });
    }
  }

  scored.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.sourceIndex !== b.sourceIndex) return a.sourceIndex - b.sourceIndex;
    return a.lineIndex - b.lineIndex;
  });

  const tail = maxLines > 0 ? scored.slice(-maxLines) : scored;
  if (tail.length === 0) return "";
  return tail.map((entry) => entry.text).join(NEWLINE) + NEWLINE;
}
