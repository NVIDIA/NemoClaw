// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess log tests. */

import { spawn } from "node:child_process";
import os from "node:os";

import { ROOT } from "./runner";
import { getOpenshellBinary, runOpenshell } from "./openshell-runtime";
import type { SandboxLogsOptions } from "./sandbox-logs-options";
import { DEFAULT_SANDBOX_LOG_LINES } from "./sandbox-logs-options";

const DEFAULT_LOGS_PROBE_TIMEOUT_MS = 5000;
const LOGS_PROBE_TIMEOUT_ENV = "NEMOCLAW_LOGS_PROBE_TIMEOUT_MS";

type SpawnLikeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};

function exitWithSpawnResult(result: SpawnLikeResult & { signal?: NodeJS.Signals | null }) {
  if (result.status !== null) {
    process.exit(result.status);
  }

  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }

  process.exit(1);
}

function getLogsProbeTimeoutMs(): number {
  const rawValue = process.env[LOGS_PROBE_TIMEOUT_ENV];
  if (!rawValue) {
    return DEFAULT_LOGS_PROBE_TIMEOUT_MS;
  }
  const parsed = Number(rawValue);
  const timeoutMs = Number.isFinite(parsed) ? Math.floor(parsed) : Number.NaN;
  return timeoutMs > 0 ? timeoutMs : DEFAULT_LOGS_PROBE_TIMEOUT_MS;
}

function describeLogProbeResult(result: SpawnLikeResult): string {
  if (result.error) {
    return result.error.message;
  }
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return `exit ${result.status ?? "unknown"}`;
}

function normalizeSandboxLogsOptions(options: SandboxLogsOptions | boolean): SandboxLogsOptions {
  if (typeof options === "boolean") {
    return { follow: options, lines: DEFAULT_SANDBOX_LOG_LINES, since: null };
  }
  return {
    follow: options.follow,
    lines: options.lines || DEFAULT_SANDBOX_LOG_LINES,
    since: options.since || null,
  };
}

function runOpenclawGatewayLogs(
  sandboxName: string,
  options: SandboxLogsOptions,
): SpawnLikeResult {
  const args = buildSandboxOpenclawGatewayLogsArgs(sandboxName, options);
  const result = runOpenshell(args, {
    stdio: "inherit",
    ignoreError: true,
    timeout: getLogsProbeTimeoutMs(),
  });
  if (result.status !== 0) {
    console.error(
      `  OpenClaw log source unavailable (${describeLogProbeResult(result)}): ` +
        `openshell ${args.join(" ")}`,
    );
  }
  return result;
}

function streamSandboxFollowLogs(sandboxName: string, options: SandboxLogsOptions): void {
  const openclawArgs = options.since
    ? null
    : buildSandboxOpenclawGatewayLogsArgs(sandboxName, options);
  const openshellArgs = buildSandboxLogsArgs(sandboxName, options);
  const spawnOptions = {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit" as const,
  };
  const sources: Array<{
    label: string;
    args: string[];
    child: import("node:child_process").ChildProcess;
    done: boolean;
  }> = [];
  let exiting = false;
  let completedSources = 0;
  let finalStatus = 0;
  let requestedExitCode: number | null = null;
  let forcedExitTimer: NodeJS.Timeout | null = null;
  let setupComplete = false;

  const stopChildren = (signal: NodeJS.Signals) => {
    for (const { child } of sources) {
      if (!child.killed && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  };
  const maybeExit = () => {
    if (!setupComplete || completedSources !== sources.length) {
      return;
    }
    if (forcedExitTimer) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    process.exit(requestedExitCode ?? finalStatus);
  };
  const exitFromSignal = (signal: NodeJS.Signals | null): number => {
    if (!signal) return 1;
    const signalNumber = os.constants.signals[signal];
    return signalNumber ? 128 + signalNumber : 1;
  };
  const markSourceDone = (
    source: (typeof sources)[number],
    status: number,
    detail: string | null = null,
  ) => {
    if (source.done) return;
    source.done = true;
    completedSources += 1;
    if (status !== 0 && finalStatus === 0) {
      finalStatus = status;
    }
    if (completedSources < sources.length && !exiting) {
      const suffix = detail || `exit ${status}`;
      console.error(`  ${source.label} stopped (${suffix}); continuing with remaining log source.`);
    }
    maybeExit();
  };
  const requestExitAfterSignal = (signal: NodeJS.Signals, exitCode: number) => {
    if (requestedExitCode !== null) return;
    exiting = true;
    requestedExitCode = exitCode;
    stopChildren(signal);
    forcedExitTimer = setTimeout(() => process.exit(exitCode), 2000);
    forcedExitTimer.unref?.();
    maybeExit();
  };

  process.once("SIGINT", () => {
    requestExitAfterSignal("SIGINT", 130);
  });
  process.once("SIGTERM", () => {
    requestExitAfterSignal("SIGTERM", 143);
  });

  const addSource = (label: string, args: string[]) => {
    const source = {
      label,
      args,
      child: spawn(getOpenshellBinary(), args, spawnOptions),
      done: false,
    };
    sources.push(source);
    source.child.on("error", (error: Error) => {
      markSourceDone(source, 1, error.message);
    });
    source.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      markSourceDone(source, code ?? exitFromSignal(signal), signal ? `signal ${signal}` : null);
    });
  };

  if (openclawArgs) {
    addSource("OpenClaw log source", openclawArgs);
  }
  enableSandboxAuditLogs(sandboxName);
  addSource("OpenShell log source", openshellArgs);
  setupComplete = true;
  maybeExit();
}

function enableSandboxAuditLogs(sandboxName: string) {
  const args = buildEnableSandboxAuditLogsArgs(sandboxName);
  const result = runOpenshell(args, {
    stdio: ["ignore", "ignore", "pipe"],
    ignoreError: true,
    timeout: getLogsProbeTimeoutMs(),
  });
  if (result.status !== 0) {
    warnSandboxAuditLogsUnavailable(sandboxName, args, result);
  }
}

function warnSandboxAuditLogsUnavailable(
  sandboxName: string,
  args: string[],
  result: SpawnLikeResult,
): void {
  const stderr = String(result.stderr || "").trim();
  console.error(
    `  Warning: failed to enable OpenShell audit logs for sandbox '${sandboxName}' ` +
      `(${describeLogProbeResult(result)}): openshell ${args.join(" ")}`,
  );
  if (stderr) {
    console.error(`  ${stderr}`);
  }
  console.error("  Policy denial events may be missing from OpenShell logs.");
}

function buildEnableSandboxAuditLogsArgs(sandboxName: string): string[] {
  return ["settings", "set", sandboxName, "--key", "ocsf_json_enabled", "--value", "true"];
}

function buildSandboxOpenclawGatewayLogsArgs(
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

function buildSandboxLogsArgs(sandboxName: string, options: SandboxLogsOptions): string[] {
  const args = ["logs", sandboxName, "-n", options.lines, "--source", "all"];
  if (options.since) {
    args.push("--since", options.since);
  }
  if (options.follow) {
    args.push("--tail");
  }
  return args;
}

export function showSandboxLogs(sandboxName: string, options: SandboxLogsOptions | boolean) {
  const logsOptions = normalizeSandboxLogsOptions(options);
  if (logsOptions.follow) {
    streamSandboxFollowLogs(sandboxName, logsOptions);
    return;
  }

  enableSandboxAuditLogs(sandboxName);
  if (!logsOptions.since) {
    runOpenclawGatewayLogs(sandboxName, logsOptions);
  }
  const args = buildSandboxLogsArgs(sandboxName, logsOptions);
  const result = runOpenshell(args, {
    stdio: "inherit",
    ignoreError: true,
  });
  if (result.status !== 0) {
    console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
  }
  exitWithSpawnResult(result);
}
