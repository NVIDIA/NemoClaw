// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import { ROOT } from "./runner";
import { getOpenshellBinary, runOpenshell } from "./adapters/openshell/runtime";
import {
  buildEnableSandboxAuditLogsArgs,
  buildSandboxLogsArgs,
  buildSandboxOpenclawGatewayLogsArgs,
  describeLogProbeResult,
  exitCodeFromSignal,
  getLogsProbeTimeoutMs,
  normalizeSandboxLogsOptions,
  type LogProbeResult,
} from "./domain/sandbox/logs";
import type { SandboxLogsOptions } from "./domain/sandbox/log-options";

/* v8 ignore next -- process exit mapping is covered through CLI subprocess log tests. */
function exitWithSpawnResult(result: LogProbeResult) {
  if (result.status !== null) {
    process.exit(result.status);
  }

  process.exit(exitCodeFromSignal(result.signal ?? null));
}

/* v8 ignore next -- OpenShell subprocess call is covered through CLI subprocess log tests. */
function runOpenclawGatewayLogs(
  sandboxName: string,
  options: SandboxLogsOptions,
): LogProbeResult {
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

/* v8 ignore next -- multi-process follow handling is covered through CLI subprocess log tests. */
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
      markSourceDone(source, code ?? exitCodeFromSignal(signal), signal ? `signal ${signal}` : null);
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

/* v8 ignore next -- OpenShell audit setting is covered through CLI subprocess log tests. */
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

/* v8 ignore next -- warning output is exercised through CLI subprocess log tests. */
function warnSandboxAuditLogsUnavailable(
  sandboxName: string,
  args: string[],
  result: LogProbeResult,
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

/* v8 ignore next -- external log streaming is covered through CLI subprocess log tests. */
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
