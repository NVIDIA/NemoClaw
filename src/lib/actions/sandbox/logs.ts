// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type StdioOptions } from "node:child_process";
import type { Writable } from "node:stream";
import { getOpenshellBinary, runOpenshell } from "../../adapters/openshell/runtime";
import * as agentRuntime from "../../agent/runtime";
import { spawnExitCode } from "../../core/process-exit";
import type { SandboxLogsOptions } from "../../domain/sandbox/log-options";
import {
  buildEnableSandboxAuditLogsArgs,
  buildSandboxLogsArgs,
  buildSandboxOpenclawGatewayLogsArgs,
  describeLogProbeResult,
  getLogsProbeTimeoutMs,
  isBrokenPipeRelayError,
  LOG_RELAY_BROKEN_PIPE_EXIT_CODE,
  type LogProbeResult,
  mergeTailLogLines,
  normalizeSandboxLogsOptions,
  tagGatewayLogLine,
  tagGatewayLogLines,
} from "../../domain/sandbox/logs";
import { ROOT } from "../../runner";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "./gateway-failure-classifier";

/**
 * How long a piped log source may keep draining after its child exits before
 * the relay stops waiting. Bounded so a lingering descendant holding the
 * child's stdout write end cannot stall follow mode (#10340).
 */
const DRAIN_GRACE_MS = 200;

// Source attribution depends only on the start of a line. Relay the rest after
// this bound so one unterminated log line cannot grow host memory without limit.
const MAX_BUFFERED_GATEWAY_LINE_PREFIX_CHARS = 4_096;

type GatewayLogChunkTagger = {
  finish: () => string;
  write: (chunk: string) => string;
};

function createGatewayLogChunkTagger(): GatewayLogChunkTagger {
  let pendingPrefix = "";
  let pendingCarriageReturn = false;
  let linePrefixRelayed = false;

  return {
    write(chunk: string): string {
      const output: string[] = [];
      let currentChunk = pendingCarriageReturn ? `\r${chunk}` : chunk;
      pendingCarriageReturn = false;
      if (currentChunk.endsWith("\r")) {
        currentChunk = currentChunk.slice(0, -1);
        pendingCarriageReturn = true;
      }
      const segments = currentChunk.split("\n");
      for (let index = 0; index < segments.length; index += 1) {
        const hasNewline = index < segments.length - 1;
        const rawSegment = segments[index] ?? "";
        const segment =
          hasNewline && rawSegment.endsWith("\r") ? rawSegment.slice(0, -1) : rawSegment;

        if (linePrefixRelayed) {
          output.push(segment);
        } else {
          const remaining = MAX_BUFFERED_GATEWAY_LINE_PREFIX_CHARS - pendingPrefix.length;
          if (segment.length <= remaining) {
            pendingPrefix += segment;
          } else {
            pendingPrefix += segment.slice(0, remaining);
            output.push(tagGatewayLogLine(pendingPrefix), segment.slice(remaining));
            pendingPrefix = "";
            linePrefixRelayed = true;
          }
        }

        if (hasNewline) {
          if (!linePrefixRelayed) {
            output.push(tagGatewayLogLine(pendingPrefix));
            pendingPrefix = "";
          }
          output.push("\n");
          linePrefixRelayed = false;
        }
      }
      return output.join("");
    },
    finish(): string {
      const finalSuffix = pendingCarriageReturn ? "\r" : "";
      pendingCarriageReturn = false;
      if (linePrefixRelayed) {
        linePrefixRelayed = false;
        return `${finalSuffix}\n`;
      }
      const finalLine = `${pendingPrefix}${finalSuffix}`;
      pendingPrefix = "";
      return finalLine ? `${tagGatewayLogLine(finalLine)}\n` : "";
    },
  };
}

type RunOpenshellOptions = Parameters<typeof runOpenshell>[1];
type RunOpenshellFn = (args: string[], options?: RunOpenshellOptions) => LogProbeResult;
type SpawnFn = typeof spawn;
type ExitFn = (code: number) => never;

export type SandboxLogsRuntimeDeps = {
  env?: NodeJS.ProcessEnv;
  exit?: ExitFn;
  getOpenshellBinary?: typeof getOpenshellBinary;
  getSessionAgent?: typeof agentRuntime.getSessionAgent;
  isDockerRuntimeDown?: typeof isDockerRuntimeDown;
  printDockerRuntimeDownGuidance?: typeof printDockerRuntimeDownGuidance;
  runOpenshell?: RunOpenshellFn;
  spawn?: SpawnFn;
  stdout?: Writable;
  writeStdout?: (chunk: string) => boolean | void;
};

function runOpenclawGatewayLogs(
  sandboxName: string,
  options: SandboxLogsOptions,
  deps: SandboxLogsRuntimeDeps,
): LogProbeResult {
  const args = buildSandboxOpenclawGatewayLogsArgs(sandboxName, options);
  // Capture stdout so the caller can merge with the OpenShell source
  // (closes #4100). stderr still inherits so warnings print directly.
  const result = (deps.runOpenshell ?? runOpenshell)(args, {
    stdio: ["ignore", "pipe", "inherit"],
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

function shouldIncludeGatewayLogSource(sandboxName: string, deps: SandboxLogsRuntimeDeps): boolean {
  const getSessionAgent = deps.getSessionAgent ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  return agentRuntime.hasGatewayRuntime(agent);
}

function streamSandboxFollowLogs(
  sandboxName: string,
  options: SandboxLogsOptions,
  deps: SandboxLogsRuntimeDeps,
): void {
  const openclawArgs =
    options.since || !shouldIncludeGatewayLogSource(sandboxName, deps)
      ? null
      : buildSandboxOpenclawGatewayLogsArgs(sandboxName, options);
  const openshellArgs = buildSandboxLogsArgs(sandboxName, options);
  const exit = deps.exit ?? process.exit;
  const outputStream = deps.stdout ?? process.stdout;
  const writesThroughOutputStream = deps.writeStdout === undefined;
  const writeStdout = deps.writeStdout ?? outputStream.write.bind(outputStream);
  // A tagged source is piped so each line can be attributed before it is
  // relayed. Every other source keeps the original raw passthrough.
  const spawnOptionsFor = (
    tagged: boolean,
  ): { cwd: string; env: NodeJS.ProcessEnv; stdio: StdioOptions } => ({
    cwd: ROOT,
    env: deps.env ?? process.env,
    stdio: tagged ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  const sources: Array<{
    label: string;
    child: import("node:child_process").ChildProcess;
    done: boolean;
  }> = [];
  let exiting = false;
  let completedSources = 0;
  let finalStatus = 0;
  let requestedExitCode: number | null = null;
  let forcedExitTimer: NodeJS.Timeout | null = null;
  let setupComplete = false;
  let outputErrorHandler: ((error: NodeJS.ErrnoException) => void) | null = null;

  const exitRelay = (code: number): never => {
    if (outputErrorHandler) {
      outputStream.off("error", outputErrorHandler);
      outputErrorHandler = null;
    }
    return exit(code);
  };

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
    exitRelay(requestedExitCode ?? finalStatus);
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
    forcedExitTimer = setTimeout(() => exitRelay(exitCode), 2000);
    forcedExitTimer.unref?.();
    maybeExit();
  };

  process.once("SIGINT", () => {
    requestExitAfterSignal("SIGINT", 130);
  });
  process.once("SIGTERM", () => {
    requestExitAfterSignal("SIGTERM", 143);
  });
  // Node reports a closed downstream pipe on process.stdout asynchronously, as
  // an `error` event rather than a throw from write(), and an unhandled one
  // crashes the CLI. Own that channel only when this relay is the writer, so an
  // injected writeStdout keeps whatever error handling its owner chose (#10340).
  if (writesThroughOutputStream) {
    outputErrorHandler = (error: NodeJS.ErrnoException) => {
      if (requestedExitCode !== null) return;
      if (isBrokenPipeRelayError(error)) {
        requestExitAfterSignal("SIGTERM", LOG_RELAY_BROKEN_PIPE_EXIT_CODE);
        return;
      }
      const suffix = typeof error.code === "string" ? ` (${error.code})` : "";
      console.error(`  Log output failed${suffix}.`);
      requestExitAfterSignal("SIGTERM", 1);
    };
    outputStream.on("error", outputErrorHandler);
  }

  const addSource = (label: string, args: string[], tagged = false) => {
    const spawnProcess = deps.spawn ?? spawn;
    const openshellBinary = (deps.getOpenshellBinary ?? getOpenshellBinary)();
    const source = {
      label,
      child: spawnProcess(openshellBinary, args, spawnOptionsFor(tagged)),
      done: false,
    };
    sources.push(source);

    const stdout = tagged ? source.child.stdout : null;
    if (!stdout) {
      source.child.on("error", (error: Error) => {
        markSourceDone(source, 1, error.message);
      });
      source.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (signal === "SIGPIPE") {
          requestExitAfterSignal("SIGTERM", LOG_RELAY_BROKEN_PIPE_EXIT_CODE);
        }
        markSourceDone(
          source,
          spawnExitCode({ status: code, signal }),
          signal ? `signal ${signal}` : null,
        );
      });
      return;
    }
    const relayStdout = stdout;

    const tagger = createGatewayLogChunkTagger();
    let exited = false;
    let ended = false;
    let exitStatus = 0;
    let exitDetail: string | null = null;
    let drainTimer: NodeJS.Timeout | null = null;
    let drainTimeRemainingMs = DRAIN_GRACE_MS;
    let drainTimerStartedAtMs: number | null = null;
    let waitingForDrain = false;
    let finalizing = false;
    let finalOutput = "";
    let pendingOutputWrites = 0;

    function completeSource(): void {
      outputStream.off("drain", resumeAfterDrain);
      relayStdout.destroy();
      markSourceDone(source, exitStatus, exitDetail);
    }

    function stopSourceDrainTimer(recordElapsedTime: boolean): void {
      if (!drainTimer) return;
      clearTimeout(drainTimer);
      drainTimer = null;
      if (recordElapsedTime && drainTimerStartedAtMs !== null) {
        drainTimeRemainingMs = Math.max(
          0,
          drainTimeRemainingMs - (Date.now() - drainTimerStartedAtMs),
        );
      }
      drainTimerStartedAtMs = null;
    }

    function maybeCompleteSource(): void {
      if (!finalizing || finalOutput.length > 0 || pendingOutputWrites > 0 || waitingForDrain) {
        return;
      }
      completeSource();
    }

    function relayOutput(chunk: string): boolean {
      if (!chunk) return true;
      let accepted: boolean | void;
      if (writesThroughOutputStream) {
        pendingOutputWrites += 1;
        let writeReturned = false;
        accepted = outputStream.write(chunk, (error?: Error | null) => {
          const recordCompletion = () => {
            pendingOutputWrites -= 1;
            if (error) {
              outputErrorHandler?.(error as NodeJS.ErrnoException);
              return;
            }
            maybeCompleteSource();
          };
          if (writeReturned) recordCompletion();
          else queueMicrotask(recordCompletion);
        });
        writeReturned = true;
      } else {
        accepted = writeStdout(chunk);
      }
      if (!writesThroughOutputStream || accepted !== false) return true;
      if (!waitingForDrain) {
        waitingForDrain = true;
        relayStdout.pause();
        stopSourceDrainTimer(true);
        outputStream.once("drain", resumeAfterDrain);
      }
      return false;
    }

    function flushFinalOutput(): void {
      if (!finalizing || waitingForDrain) return;
      const chunk = finalOutput;
      finalOutput = "";
      relayOutput(chunk);
      maybeCompleteSource();
    }

    function beginFinalization(): void {
      if (source.done || finalizing) return;
      finalizing = true;
      stopSourceDrainTimer(false);
      relayStdout.destroy();
      finalOutput = tagger.finish();
      flushFinalOutput();
    }

    function startSourceDrainTimer(): void {
      if (source.done || finalizing || ended || !exited || waitingForDrain || drainTimer) return;
      if (drainTimeRemainingMs <= 0) {
        beginFinalization();
        return;
      }
      drainTimerStartedAtMs = Date.now();
      drainTimer = setTimeout(() => {
        drainTimer = null;
        drainTimerStartedAtMs = null;
        drainTimeRemainingMs = 0;
        beginFinalization();
      }, drainTimeRemainingMs);
      drainTimer.unref?.();
    }

    function resumeAfterDrain(): void {
      waitingForDrain = false;
      if (finalizing) {
        flushFinalOutput();
        return;
      }
      startSourceDrainTimer();
      if (!source.done && !relayStdout.destroyed) relayStdout.resume();
    }

    relayStdout.setEncoding("utf8");
    relayStdout.on("data", (chunk: string) => {
      if (source.done || finalizing) return;
      relayOutput(tagger.write(chunk));
    });
    // A descendant can inherit stdout and prevent `end`. Count only time that
    // stdout can flow so output backpressure cannot discard buffered data.
    const settleAfterExit = () => {
      ended = true;
      if (exited) beginFinalization();
    };
    relayStdout.on("end", settleAfterExit);
    relayStdout.on("error", (error: NodeJS.ErrnoException) => {
      if (source.done) return;
      const suffix = typeof error.code === "string" ? ` (${error.code})` : "";
      console.error(`  ${source.label} read failed${suffix}.`);
      exitStatus = 1;
      exitDetail = `read error${suffix}`;
      if (
        !exited &&
        !source.child.killed &&
        source.child.exitCode === null &&
        source.child.signalCode === null
      ) {
        source.child.kill("SIGTERM");
      }
      beginFinalization();
    });
    source.child.on("error", (error: Error) => {
      if (source.done) return;
      exitStatus = 1;
      exitDetail = error.message;
      beginFinalization();
    });
    source.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (source.done || finalizing) return;
      exited = true;
      exitStatus = spawnExitCode({ status: code, signal });
      exitDetail = signal ? `signal ${signal}` : null;
      if (ended) {
        beginFinalization();
        return;
      }
      startSourceDrainTimer();
    });
  };

  if (openclawArgs) {
    addSource("OpenClaw log source", openclawArgs, true);
  }
  enableSandboxAuditLogs(sandboxName, deps);
  addSource("OpenShell log source", openshellArgs);
  setupComplete = true;
  maybeExit();
}

function enableSandboxAuditLogs(sandboxName: string, deps: SandboxLogsRuntimeDeps) {
  const args = buildEnableSandboxAuditLogsArgs(sandboxName);
  const result = (deps.runOpenshell ?? runOpenshell)(args, {
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

export function showSandboxLogs(sandboxName: string, options: SandboxLogsOptions | boolean) {
  showSandboxLogsWithDeps(sandboxName, options);
}

export function showSandboxLogsWithDeps(
  sandboxName: string,
  options: SandboxLogsOptions | boolean,
  deps: SandboxLogsRuntimeDeps = {},
) {
  // Normalize/validate options before any host I/O so malformed flags still
  // surface their own error rather than a Docker-outage message.
  const logsOptions = normalizeSandboxLogsOptions(options);

  // Preflight the Docker daemon so a host runtime outage is named as such
  // instead of surfacing as opaque "log source unavailable" failures from the
  // underlying OpenShell commands (#4428).
  if ((deps.isDockerRuntimeDown ?? isDockerRuntimeDown)(sandboxName)) {
    (deps.printDockerRuntimeDownGuidance ?? printDockerRuntimeDownGuidance)(sandboxName, {
      retryCommand: "logs",
    });
    (deps.exit ?? process.exit)(1);
  }

  if (logsOptions.follow) {
    streamSandboxFollowLogs(sandboxName, logsOptions, deps);
    return;
  }

  enableSandboxAuditLogs(sandboxName, deps);

  // Capture stdout from both sources so --tail N can be applied once
  // to the merged stream rather than independently per source
  // (which previously returned up to 2*N lines). Closes #4100.
  let gatewayResult: LogProbeResult | null = null;
  if (!logsOptions.since && shouldIncludeGatewayLogSource(sandboxName, deps)) {
    gatewayResult = runOpenclawGatewayLogs(sandboxName, logsOptions, deps);
  }

  const openshellArgs = buildSandboxLogsArgs(sandboxName, logsOptions);
  const openshellResult = (deps.runOpenshell ?? runOpenshell)(openshellArgs, {
    stdio: ["ignore", "pipe", "inherit"],
    ignoreError: true,
  });

  const targetLines = Number(logsOptions.lines);
  const maxLines = Number.isFinite(targetLines) && targetLines > 0 ? targetLines : 0;
  const sources: string[] = [];
  // Only the gateway source is rewritten. OpenShell already tags its own lines
  // ([sandbox], [proxy], ...), so tagging it too would double-tag (#10340).
  if (gatewayResult?.stdout) sources.push(tagGatewayLogLines(String(gatewayResult.stdout)));
  if (openshellResult.stdout) sources.push(String(openshellResult.stdout));
  const merged = mergeTailLogLines(sources, maxLines);
  if (merged) {
    (deps.writeStdout ?? process.stdout.write.bind(process.stdout))(merged);
  }

  if (openshellResult.status !== 0) {
    console.error(
      `  Command failed (exit ${openshellResult.status}): openshell ${openshellArgs.join(" ")}`,
    );
  }
  (deps.exit ?? process.exit)(spawnExitCode(openshellResult));
}
