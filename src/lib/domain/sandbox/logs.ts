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

export function normalizeSandboxLogsOptions(options: SandboxLogsOptions | boolean): SandboxLogsOptions {
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
