// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnOptions, spawn } from "node:child_process";

import { redact } from "../security/redact";
import { ROOT } from "../state/paths";
import {
  BUILD_PROGRESS_PATTERNS,
  type CreatePhase,
  matchesAny,
  PULL_PROGRESS_PATTERNS,
  UPLOAD_PROGRESS_PATTERNS,
  VISIBLE_PROGRESS_PATTERNS,
} from "./create-stream-progress";
import { getReadyCheckOutputPatterns } from "./create-stream-ready-gate";

export interface StreamSandboxCreateResult {
  status: number;
  output: string;
  sawProgress: boolean;
  forcedReady?: boolean;
}

export interface StreamSandboxCreateOptions {
  readyCheck?: (() => boolean) | null;
  // Optional poll side effect. Must be paired with failureCheck so any
  // observed side-effect error has an authoritative terminal-state classifier.
  onPoll?: (() => void) | null;
  failureCheck?: (() => string | null | undefined) | null;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  silentPhaseMs?: number;
  logLine?: (line: string) => void;
  traceEvent?: (name: string, attributes?: Record<string, unknown>) => void;
  // Optional guard for the early-ready escape hatch. When set, readyCheck()
  // alone cannot detach the create stream until at least one streamed output
  // line matches a configured pattern.
  readyCheckOutputPatterns?: readonly RegExp[];
  // Initial progress phase:
  //   build  — docker-building the sandbox image
  //   upload — pushing the built image into the gateway registry
  //   create — gateway provisioning the sandbox from the image
  //   ready  — waiting for the sandbox to reach Ready state
  // Defaults to "build".
  initialPhase?: "build" | "upload" | "create" | "ready";
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => StreamableChildProcess;
}

export interface StreamableReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  removeAllListeners?(event?: string): this;
  destroy?(): void;
}

export interface StreamableChildProcess {
  stdout: StreamableReadable | null;
  stderr: StreamableReadable | null;
  kill?(signal?: NodeJS.Signals | number): boolean;
  removeAllListeners?(event?: string | symbol): void;
  unref?(): void;
  on(event: "error", listener: (error: Error & { code?: string }) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

const CLASSIC_DOCKER_STEP_RE = /^\s*Step (\d+)\/(\d+) : (.+)$/;
const BUILDKIT_STEP_RE = /^#(\d+)\s+(.+)$/;

/**
 * @deprecated Prefer the argv overload `streamSandboxCreate(command, args, env, options)` for
 * trusted create paths. This legacy overload preserves shell-compatible callers by executing
 * `bash -lc <command>`, so callers must not include unquoted user-controlled input. Remove
 * this transitional overload in the #6258 follow-up once external callers have migrated.
 */
export function streamSandboxCreate(
  command: string,
  env?: NodeJS.ProcessEnv,
  options?: StreamSandboxCreateOptions,
): Promise<StreamSandboxCreateResult>;
export function streamSandboxCreate(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  options?: StreamSandboxCreateOptions,
): Promise<StreamSandboxCreateResult>;
export function streamSandboxCreate(
  command: string,
  argsOrEnv: readonly string[] | NodeJS.ProcessEnv = process.env,
  envOrOptions: NodeJS.ProcessEnv | StreamSandboxCreateOptions | undefined = undefined,
  maybeOptions: StreamSandboxCreateOptions = {},
): Promise<StreamSandboxCreateResult> {
  const hasArgs = Array.isArray(argsOrEnv);
  const commandArgs = hasArgs ? argsOrEnv : ["-lc", command];
  const spawnCommand = hasArgs ? command : "bash";
  const env = hasArgs
    ? ((envOrOptions ?? process.env) as NodeJS.ProcessEnv)
    : (argsOrEnv as NodeJS.ProcessEnv);
  const options = hasArgs ? maybeOptions : ((envOrOptions ?? {}) as StreamSandboxCreateOptions);
  if (options.onPoll && !options.failureCheck) {
    throw new Error(
      "streamSandboxCreate onPoll requires failureCheck (e.g., dockerGpuCreatePatch.createFailureMessage)",
    );
  }
  const child: StreamableChildProcess = (options.spawnImpl ?? spawn)(spawnCommand, commandArgs, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logLine = options.logLine ?? console.log;
  const traceEvent = options.traceEvent ?? (() => {});
  const lines: string[] = [];
  const pending = { stdout: "", stderr: "" };
  let lastPrintedLine = "";
  let sawProgress = false;
  const readyCheckOutputPatterns = getReadyCheckOutputPatterns(
    env,
    options.readyCheckOutputPatterns,
  );
  let readyCheckOutputMatched = readyCheckOutputPatterns.length === 0;
  let printedReadyCheckOutputWait = false;
  let settled = false;
  let polling = false;
  const pollIntervalMs = options.pollIntervalMs || 2000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs || 5000;
  const silentPhaseMs = options.silentPhaseMs || 15000;
  const startedAt = Date.now();
  let lastOutputAt = startedAt;

  let currentPhase: CreatePhase | null = null;
  let lastHeartbeatPhase: CreatePhase | null = null;
  let lastHeartbeatBucket = -1;
  let resolvePromise: (result: StreamSandboxCreateResult) => void;
  let buildStartedAtMs: number | null = null;
  let buildTimingFinished = false;
  let activeBuildStep: {
    label: string;
    instruction: string;
    startedAtMs: number;
  } | null = null;

  function getDisplayWidth() {
    return Math.max(60, Number(process.stdout.columns || 100));
  }

  function trimDisplayLine(line: string) {
    const width = getDisplayWidth();
    const maxLen = Math.max(40, width - 4);
    if (line.length <= maxLen) return line;
    return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function printProgressLine(line: string) {
    const display = trimDisplayLine(line);
    if (display !== lastPrintedLine) {
      logLine(display);
      lastPrintedLine = display;
    }
  }

  function formatDuration(ms: number) {
    return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  }

  function timingNow() {
    return Date.now();
  }

  function appendTimingLine(line: string) {
    lines.push(line);
    printProgressLine(line);
  }

  function emitTraceEvent(name: string, attributes: Record<string, unknown> = {}) {
    traceEvent(name, attributes);
  }

  function markBuildStarted(nowMs: number = timingNow()) {
    if (buildStartedAtMs === null) {
      buildStartedAtMs = nowMs;
    }
  }

  function finishActiveBuildStep(status: "completed" | "stopped", nowMs: number = timingNow()) {
    if (!activeBuildStep) return;
    const elapsedMs = nowMs - activeBuildStep.startedAtMs;
    const phrase = status === "completed" ? "completed in" : "stopped after";
    const elapsed = formatDuration(elapsedMs);
    appendTimingLine(
      `  ${activeBuildStep.label} ${phrase} ${elapsed} (${activeBuildStep.instruction})`,
    );
    emitTraceEvent("docker_build_step_end", {
      status,
      step: activeBuildStep.label,
      instruction: activeBuildStep.instruction,
      duration_ms: elapsedMs,
    });
    activeBuildStep = null;
  }

  function finishBuildTiming(status: "completed" | "stopped", nowMs: number = timingNow()) {
    if (buildTimingFinished) return;
    finishActiveBuildStep(status, nowMs);
    if (buildStartedAtMs !== null) {
      const elapsedMs = nowMs - buildStartedAtMs;
      const phrase = status === "completed" ? "completed in" : "stopped after";
      appendTimingLine(`  Sandbox image build ${phrase} ${formatDuration(elapsedMs)}`);
      emitTraceEvent("docker_build_end", {
        status,
        duration_ms: elapsedMs,
      });
    }
    buildTimingFinished = true;
  }

  function maybeStartClassicBuildStep(line: string) {
    const match = line.match(CLASSIC_DOCKER_STEP_RE);
    if (!match) return;
    const nowMs = timingNow();
    finishActiveBuildStep("completed", nowMs);
    markBuildStarted(nowMs);
    activeBuildStep = {
      label: `Step ${match[1]}/${match[2]}`,
      instruction: match[3].trim().replace(/\s+/g, " "),
      startedAtMs: nowMs,
    };
    emitTraceEvent("docker_build_step_start", {
      step: activeBuildStep.label,
      index: Number(match[1]),
      total: Number(match[2]),
      instruction: activeBuildStep.instruction,
    });
  }

  function maybeRecordBuildKitStep(line: string) {
    const match = line.match(BUILDKIT_STEP_RE);
    if (!match) return;
    if (!matchesAny(line, BUILD_PROGRESS_PATTERNS) && !matchesAny(line, PULL_PROGRESS_PATTERNS)) {
      return;
    }
    emitTraceEvent("docker_buildkit_progress", {
      step: Number(match[1]),
      detail: match[2].trim().replace(/\s+/g, " "),
    });
  }

  function elapsedSeconds() {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function setPhase(nextPhase: CreatePhase | null) {
    if (!nextPhase || nextPhase === currentPhase) return;
    currentPhase = nextPhase;
    lastHeartbeatPhase = null;
    lastHeartbeatBucket = -1;
    const phaseLine =
      nextPhase === "pull"
        ? "  Pulling base image from registry..."
        : nextPhase === "build"
          ? "  Building sandbox image..."
          : nextPhase === "upload"
            ? "  Uploading image into OpenShell gateway..."
            : nextPhase === "create"
              ? "  Creating sandbox in gateway..."
              : nextPhase === "ready"
                ? "  Waiting for sandbox to become ready..."
                : null;
    emitTraceEvent("sandbox_create_phase", {
      phase: nextPhase,
      elapsed_seconds: elapsedSeconds(),
    });
    if (phaseLine) printProgressLine(phaseLine);
  }

  function flushLine(rawLine: string) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    lastOutputAt = Date.now();
    if (!readyCheckOutputMatched && matchesAny(line, readyCheckOutputPatterns)) {
      readyCheckOutputMatched = true;
    }
    if (matchesAny(line, BUILD_PROGRESS_PATTERNS)) {
      markBuildStarted();
    }
    maybeStartClassicBuildStep(line);
    maybeRecordBuildKitStep(line);
    if (/^(?:Successfully built | {2}Built image )/.test(line)) {
      finishBuildTiming("completed");
    }
    if (/^ {2}Built image /.test(line)) {
      setPhase("create");
    } else if (matchesAny(line, BUILD_PROGRESS_PATTERNS)) {
      setPhase("build");
    } else if (matchesAny(line, PULL_PROGRESS_PATTERNS)) {
      setPhase("pull");
    } else if (matchesAny(line, UPLOAD_PROGRESS_PATTERNS)) {
      setPhase("upload");
    } else if (/^Created sandbox: /.test(line)) {
      setPhase("create");
    }
    if (shouldShowLine(line) && line !== lastPrintedLine) {
      printProgressLine(line);
      sawProgress = true;
    }
  }

  function shouldShowLine(line: string) {
    return matchesAny(line, VISIBLE_PROGRESS_PATTERNS);
  }

  function onChunk(stream: keyof typeof pending, chunk: Buffer | string) {
    pending[stream] += chunk.toString();
    const parts = pending[stream].split("\n");
    pending[stream] = parts.pop() ?? "";
    parts.forEach(flushLine);
  }

  function flushPendingLines() {
    for (const stream of ["stdout", "stderr"] as const) {
      if (!pending[stream]) continue;
      const trailing = pending[stream];
      pending[stream] = "";
      flushLine(trailing);
    }
  }

  function finish(status: number, overrides: Partial<StreamSandboxCreateResult> = {}) {
    if (settled) return;
    settled = true;
    flushPendingLines();
    if (!buildTimingFinished && buildStartedAtMs !== null) {
      finishBuildTiming(status === 0 ? "completed" : "stopped");
    }
    if (readyTimer) clearInterval(readyTimer);
    clearInterval(heartbeatTimer);
    resolvePromise({
      status,
      output: lines.join("\n"),
      sawProgress,
      ...overrides,
    });
  }

  function detachChild() {
    child.stdout?.removeAllListeners?.("data");
    child.stderr?.removeAllListeners?.("data");
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
    child.removeAllListeners?.("error");
    child.removeAllListeners?.("close");
    child.unref?.();
  }

  child.stdout?.on("data", (chunk) => onChunk("stdout", chunk));
  child.stderr?.on("data", (chunk) => onChunk("stderr", chunk));

  const readyTimer = options.readyCheck
    ? setInterval(() => {
        if (settled || polling) return;
        polling = true;
        try {
          let ready = false;
          try {
            ready = !!options.readyCheck?.();
          } catch (error) {
            emitTraceEvent("sandbox_create_ready_check_error", {
              message: redact(error instanceof Error ? error.message : String(error)),
            });
            return;
          }
          if (ready) {
            setPhase("ready");
            if (!readyCheckOutputMatched) {
              if (!printedReadyCheckOutputWait) {
                const detail =
                  "Sandbox reported Ready; waiting for startup command output before detaching.";
                lines.push(detail);
                printProgressLine(`  ${detail}`);
                printedReadyCheckOutputWait = true;
              }
              return;
            }
            const detail = "Sandbox reported Ready before create stream exited; continuing.";
            lines.push(detail);
            printProgressLine(`  ${detail}`);
            try {
              child.kill?.("SIGTERM");
            } catch {
              // Best effort only — the child may have already exited.
            }
            detachChild();
            sawProgress = true;
            finish(0, { forcedReady: true });
            return;
          }

          let pollFailure: string | null | undefined;
          try {
            options.onPoll?.();
          } catch (error) {
            emitTraceEvent("sandbox_create_poll_error", {
              message: redact(error instanceof Error ? error.message : String(error)),
            });
            pollFailure = options.failureCheck?.() ?? "Sandbox create poll side effect failed.";
          }

          const failure = pollFailure ?? options.failureCheck?.();
          if (!failure) return;
          const detail = String(failure);
          lines.push(detail);
          printProgressLine(`  ${detail}`);
          try {
            child.kill?.("SIGTERM");
          } catch {
            // Best effort only — the child may have already exited.
          }
          detachChild();
          sawProgress = true;
          finish(1);
        } finally {
          polling = false;
        }
      }, pollIntervalMs)
    : null;
  readyTimer?.unref?.();

  setPhase(options.initialPhase ?? "build");
  const heartbeatTimer = setInterval(() => {
    if (settled) return;
    const silentForMs = Date.now() - lastOutputAt;
    if (silentForMs < silentPhaseMs) return;
    const elapsed = elapsedSeconds();
    const bucket = Math.floor(elapsed / 15);
    if (currentPhase === lastHeartbeatPhase && bucket === lastHeartbeatBucket) {
      return;
    }
    const heartbeatLine =
      currentPhase === "pull"
        ? `  Still pulling base image from registry... (${elapsed}s elapsed)`
        : currentPhase === "upload"
          ? `  Still uploading image into OpenShell gateway... (${elapsed}s elapsed)`
          : currentPhase === "create"
            ? `  Still creating sandbox in gateway... (${elapsed}s elapsed)`
            : currentPhase === "ready"
              ? `  Still waiting for sandbox to become ready... (${elapsed}s elapsed)`
              : `  Still building sandbox image... (${elapsed}s elapsed)`;
    if (trimDisplayLine(heartbeatLine) !== lastPrintedLine) {
      printProgressLine(heartbeatLine);
      lastHeartbeatPhase = currentPhase;
      lastHeartbeatBucket = bucket;
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  return new Promise((resolve) => {
    resolvePromise = resolve;
    child.on("error", (error) => {
      const code = error?.code;
      const detail = code
        ? `spawn failed: ${error.message} (${code})`
        : `spawn failed: ${error.message}`;
      lines.push(detail);
      finish(1);
    });

    child.on("close", (code) => {
      // One last ready-check: the sandbox may have become Ready between the
      // last poll tick and the stream exit (e.g. SSH 255 after "Created sandbox:").
      flushPendingLines();
      if (code && code !== 0 && options.readyCheck) {
        try {
          if (options.readyCheck() && readyCheckOutputMatched) {
            finish(0, { forcedReady: true });
            return;
          }
        } catch {
          // Ignore — fall through to normal exit handling.
        }
      }
      finish(code ?? 1);
    });
  });
}
