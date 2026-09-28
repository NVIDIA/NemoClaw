// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Writable } from "node:stream";
import { cliOpenShellSandboxLogs } from "../../adapters/openshell/sandbox-logs-cli";
import type {
  OpenShellSandboxLogFollowSession,
  OpenShellSandboxLogOutcome,
  OpenShellSandboxLogs,
} from "../../adapters/openshell/sandbox-logs";
import { cliOpenShellSandboxSettings } from "../../adapters/openshell/sandbox-settings-cli";
import type { OpenShellSandboxSettings } from "../../adapters/openshell/sandbox-settings";
import { selectedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import * as agentRuntime from "../../agent/runtime";
import type { SandboxLogsOptions } from "../../domain/sandbox/log-options";
import {
  getLogsProbeTimeoutMs,
  isBrokenPipeRelayError,
  LOG_RELAY_BROKEN_PIPE_EXIT_CODE,
  mergeTailLogLines,
  normalizeSandboxLogsOptions,
  tagGatewayLogLine,
  tagGatewayLogLines,
} from "../../domain/sandbox/logs";
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
const OPENSHELL_UNAVAILABLE_GUIDANCE =
  "openshell CLI not found. Install OpenShell before using sandbox commands.";

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

type ExitFn = (code: number) => never;

export type SandboxLogsRuntimeDeps = {
  enableAuditLogs?: OpenShellSandboxSettings["enableAuditLogs"];
  exit?: ExitFn;
  getSessionAgent?: typeof agentRuntime.getSessionAgent;
  isDockerRuntimeDown?: typeof isDockerRuntimeDown;
  logs?: OpenShellSandboxLogs;
  printDockerRuntimeDownGuidance?: typeof printDockerRuntimeDownGuidance;
  stderr?: Writable;
  stdout?: Writable;
  writeStderr?: (chunk: string) => boolean | void;
  writeStdout?: (chunk: string) => boolean | void;
};

function describeLogOutcome(outcome: OpenShellSandboxLogOutcome): string {
  if (outcome.kind === "failed") return outcome.error.message;
  if (outcome.termination === "broken_pipe") return "signal SIGPIPE";
  if (outcome.termination === "hangup") return "signal SIGHUP";
  if (outcome.termination === "interrupted") return "signal SIGINT";
  if (outcome.termination === "terminated") return "signal SIGTERM";
  if (outcome.termination === "other_signal") return "signal unknown";
  return `exit ${outcome.exitCode}`;
}

function isOpenShellUnavailable(outcome: OpenShellSandboxLogOutcome): boolean {
  return outcome.kind === "failed" && outcome.error.kind === "unavailable";
}

function shouldIncludeGatewayLogSource(sandboxName: string, deps: SandboxLogsRuntimeDeps): boolean {
  const getSessionAgent = deps.getSessionAgent ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  return agentRuntime.hasGatewayRuntime(agent);
}

async function streamSandboxFollowLogs(
  sandboxName: string,
  options: SandboxLogsOptions,
  deps: SandboxLogsRuntimeDeps,
): Promise<void> {
  const logs = deps.logs ?? cliOpenShellSandboxLogs;
  const exit = deps.exit ?? process.exit;
  const availabilityError = logs.checkAvailability();
  if (availabilityError?.kind === "unavailable") {
    console.error(OPENSHELL_UNAVAILABLE_GUIDANCE);
    exit(1);
    return;
  }
  const target = selectedOpenShellGateway();
  const includeGateway = !options.since && shouldIncludeGatewayLogSource(sandboxName, deps);
  const outputStream = deps.stdout ?? process.stdout;
  const diagnosticStream = deps.stderr ?? process.stderr;
  const writesThroughOutputStream = deps.writeStdout === undefined;
  const writeStderr = deps.writeStderr ?? diagnosticStream.write.bind(diagnosticStream);
  const writeStdout = deps.writeStdout ?? outputStream.write.bind(outputStream);
  const sources: Array<{
    label: string;
    session: OpenShellSandboxLogFollowSession;
    done: boolean;
    cleanupDiagnostic: () => void;
  }> = [];
  let exiting = false;
  let completedSources = 0;
  let finalStatus = 0;
  let requestedExitCode: number | null = null;
  let forcedExitTimer: NodeJS.Timeout | null = null;
  let setupComplete = false;
  let outputErrorHandler: ((error: NodeJS.ErrnoException) => void) | null = null;
  const onInterrupt = () => requestExitAfterSignal("SIGINT", 130);
  const onTerminate = () => requestExitAfterSignal("SIGTERM", 143);

  const exitRelay = (code: number): never => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (outputErrorHandler) {
      outputStream.off("error", outputErrorHandler);
      outputErrorHandler = null;
    }
    for (const source of sources) source.cleanupDiagnostic();
    return exit(code);
  };

  const stopChildren = (signal: NodeJS.Signals) => {
    const reason = signal === "SIGINT" ? "interrupt" : "terminate";
    for (const { session } of sources) session.cancel(reason);
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
    source.cleanupDiagnostic();
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
  const requestUnavailableExit = () => {
    if (requestedExitCode !== null) return;
    console.error(OPENSHELL_UNAVAILABLE_GUIDANCE);
    requestExitAfterSignal("SIGTERM", 1);
  };

  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
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

  const addSource = (label: string, sourceKind: "gateway" | "openshell", tagged = false) => {
    const session = logs.follow({
      target,
      sandboxName,
      source: sourceKind,
      lines: options.lines,
      since: sourceKind === "openshell" ? options.since : null,
      timeoutMs: getLogsProbeTimeoutMs(),
    });
    const diagnostic = session.diagnostic;
    let waitingForDiagnosticDrain = false;
    const resumeDiagnostic = () => {
      waitingForDiagnosticDrain = false;
      diagnostic?.resume();
    };
    let diagnosticClosed = false;
    const cleanupDiagnostic = () => {
      if (diagnosticClosed) return;
      diagnosticClosed = true;
      diagnosticStream.off("drain", resumeDiagnostic);
      diagnostic?.close();
    };
    const source = {
      label,
      session,
      done: false,
      cleanupDiagnostic,
    };
    sources.push(source);

    diagnostic?.onChunk((chunk) => {
      if (writeStderr(chunk) === false && !waitingForDiagnosticDrain) {
        waitingForDiagnosticDrain = true;
        diagnostic.pause();
        diagnosticStream.once("drain", resumeDiagnostic);
      }
    });
    diagnostic?.onError((error: NodeJS.ErrnoException) => {
      const suffix = typeof error.code === "string" ? ` (${error.code})` : "";
      console.error(`  ${label} diagnostic read failed${suffix}.`);
      cleanupDiagnostic();
    });

    const stdout = tagged ? session.output : null;
    if (!stdout) {
      void session.completion.then(({ outcome }) => {
        if (isOpenShellUnavailable(outcome)) {
          requestUnavailableExit();
        }
        if (outcome.kind === "completed" && outcome.termination === "broken_pipe") {
          requestExitAfterSignal("SIGTERM", LOG_RELAY_BROKEN_PIPE_EXIT_CODE);
        }
        markSourceDone(source, outcome.exitCode, describeLogOutcome(outcome));
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
      relayStdout.close();
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
      relayStdout.close();
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
      if (!source.done) relayStdout.resume();
    }

    relayStdout.onChunk((chunk) => {
      if (source.done || finalizing) return;
      relayOutput(tagger.write(chunk));
    });
    // A descendant can inherit stdout and prevent `end`. Count only time that
    // stdout can flow so output backpressure cannot discard buffered data.
    const settleAfterExit = () => {
      ended = true;
      if (exited) beginFinalization();
    };
    relayStdout.onEnd(settleAfterExit);
    relayStdout.onError((error: NodeJS.ErrnoException) => {
      if (source.done) return;
      const suffix = typeof error.code === "string" ? ` (${error.code})` : "";
      console.error(`  ${source.label} read failed${suffix}.`);
      exitStatus = 1;
      exitDetail = `read error${suffix}`;
      if (!exited) source.session.cancel("terminate");
      beginFinalization();
    });
    void session.completion.then(({ outcome }) => {
      if (source.done || finalizing) return;
      exited = true;
      exitStatus = outcome.exitCode;
      exitDetail = describeLogOutcome(outcome);
      if (ended) {
        beginFinalization();
        return;
      }
      startSourceDrainTimer();
    });
  };

  if (includeGateway) {
    addSource("OpenClaw log source", "gateway", true);
  }
  await enableSandboxAuditLogs(sandboxName, deps);
  if (requestedExitCode !== null) {
    setupComplete = true;
    maybeExit();
    return;
  }
  addSource("OpenShell log source", "openshell");
  setupComplete = true;
  maybeExit();
}

async function enableSandboxAuditLogs(sandboxName: string, deps: SandboxLogsRuntimeDeps) {
  const result = await (deps.enableAuditLogs ?? cliOpenShellSandboxSettings.enableAuditLogs)({
    target: selectedOpenShellGateway(),
    sandboxName,
    timeoutMs: getLogsProbeTimeoutMs(),
  });
  if (!result.ok) {
    console.error(
      `  Warning: failed to enable OpenShell audit logs for sandbox '${sandboxName}': ${result.error.message}`,
    );
    console.error("  Policy denial events may be missing from OpenShell logs.");
  }
}

export async function showSandboxLogs(sandboxName: string, options: SandboxLogsOptions | boolean) {
  await showSandboxLogsWithDeps(sandboxName, options);
}

export async function showSandboxLogsWithDeps(
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
    await streamSandboxFollowLogs(sandboxName, logsOptions, deps);
    return;
  }

  await enableSandboxAuditLogs(sandboxName, deps);
  const logs = deps.logs ?? cliOpenShellSandboxLogs;
  const target = selectedOpenShellGateway();

  // Capture stdout from both sources so --tail N can be applied once
  // to the merged stream rather than independently per source
  // (which previously returned up to 2*N lines). Closes #4100.
  let gatewayResult: Awaited<ReturnType<OpenShellSandboxLogs["read"]>> | null = null;
  if (!logsOptions.since && shouldIncludeGatewayLogSource(sandboxName, deps)) {
    gatewayResult = await logs.read({
      target,
      sandboxName,
      source: "gateway",
      lines: logsOptions.lines,
      since: null,
      timeoutMs: getLogsProbeTimeoutMs(),
    });
    if (gatewayResult.diagnostic) {
      (deps.writeStderr ?? process.stderr.write.bind(process.stderr))(gatewayResult.diagnostic);
    }
    if (isOpenShellUnavailable(gatewayResult.outcome)) {
      console.error(OPENSHELL_UNAVAILABLE_GUIDANCE);
      (deps.exit ?? process.exit)(1);
      return;
    }
    if (gatewayResult.outcome.kind === "failed" || gatewayResult.outcome.exitCode !== 0) {
      console.error(
        `  OpenClaw log source unavailable (${describeLogOutcome(gatewayResult.outcome)}).`,
      );
    }
  }

  const openshellResult = await logs.read({
    target,
    sandboxName,
    source: "openshell",
    lines: logsOptions.lines,
    since: logsOptions.since,
    timeoutMs: getLogsProbeTimeoutMs(),
  });
  if (openshellResult.diagnostic) {
    (deps.writeStderr ?? process.stderr.write.bind(process.stderr))(openshellResult.diagnostic);
  }
  if (isOpenShellUnavailable(openshellResult.outcome)) {
    console.error(OPENSHELL_UNAVAILABLE_GUIDANCE);
    (deps.exit ?? process.exit)(1);
    return;
  }

  const targetLines = Number(logsOptions.lines);
  const maxLines = Number.isFinite(targetLines) && targetLines > 0 ? targetLines : 0;
  const sources: string[] = [];
  // Only the gateway source is rewritten. OpenShell already tags its own lines
  // ([sandbox], [proxy], ...), so tagging it too would double-tag (#10340).
  if (gatewayResult?.content) sources.push(tagGatewayLogLines(gatewayResult.content));
  if (openshellResult.content) sources.push(openshellResult.content);
  const merged = mergeTailLogLines(sources, maxLines);
  if (merged) {
    (deps.writeStdout ?? process.stdout.write.bind(process.stdout))(merged);
  }

  if (openshellResult.outcome.kind === "failed" || openshellResult.outcome.exitCode !== 0) {
    console.error(
      `  OpenShell log source failed (${describeLogOutcome(openshellResult.outcome)}).`,
    );
  }
  (deps.exit ?? process.exit)(openshellResult.outcome.exitCode);
}
