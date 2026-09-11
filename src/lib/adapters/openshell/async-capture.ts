// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";

export type OpenshellSpawn = typeof spawn;

export type OpenshellAsyncCaptureSignalSource = {
  add: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
  remove: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
};

export type OpenshellAsyncCaptureLifecycleOptions = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  /** Nonempty input selects a pipe and is always ended. Empty input uses an ignored stdin. */
  input?: string;
  killGraceMs?: number;
  outputLimitBytes?: number;
  signalSource?: OpenshellAsyncCaptureSignalSource;
  spawnImpl?: OpenshellSpawn;
  timeoutKillSignal?: "SIGTERM" | "SIGKILL";
  timeoutMilliseconds?: number;
}>;

export type OpenshellAsyncCaptureLifecycleResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  timeoutSignal?: NodeJS.Signals;
}>;

function timeoutError(binary: string, args: string[], timeout: number): NodeJS.ErrnoException {
  const error = new Error(
    `spawn ${binary} ${args.join(" ")} timed out after ${timeout} ms`,
  ) as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Own the asynchronous OpenShell child-process lifecycle shared by legacy
 * status capture and the typed buffered sandbox-command adapter.
 */
export function captureOpenshellCommandAsyncResult(
  binary: string,
  args: readonly string[],
  opts: OpenshellAsyncCaptureLifecycleOptions = {},
): Promise<OpenshellAsyncCaptureLifecycleResult> {
  const spawnImpl = opts.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const hasInput = opts.input !== undefined && opts.input.length > 0;
    let child: ChildProcess;
    try {
      child = spawnImpl(binary, [...args], {
        cwd: opts.cwd,
        env: opts.environment,
        detached: process.platform !== "win32",
        stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
      }) as ChildProcess;
    } catch (error) {
      resolve({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let interruptedBy: "SIGTERM" | "SIGINT" | null = null;
    let timeoutSignal: NodeJS.Signals | null = null;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let forceHandle: NodeJS.Timeout | undefined;
    let releaseSignals = () => {};
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputLimitBytes = 0;
    if (opts.outputLimitBytes === undefined || opts.outputLimitBytes === Number.POSITIVE_INFINITY) {
      outputLimitBytes = Number.POSITIVE_INFINITY;
    } else if (Number.isFinite(opts.outputLimitBytes)) {
      outputLimitBytes = Math.max(0, opts.outputLimitBytes);
    }
    const killGraceMs = opts.killGraceMs ?? 1000;

    const clearTimers = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      if (forceHandle) clearTimeout(forceHandle);
    };
    const captured = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    });
    const settle = (result: OpenshellAsyncCaptureLifecycleResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      releaseSignals();
      resolve(result);
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const currentBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const chunks = stream === "stdout" ? stdoutChunks : stderrChunks;
      const available = Math.max(0, outputLimitBytes - currentBytes);
      if (available > 0) chunks.push(bytes.subarray(0, available));
      if (stream === "stdout") stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (bytes.length <= available) return;
      const error = Object.assign(new Error(`${stream} exceeded the buffered output limit`), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      signalProcessTree(child, "SIGKILL");
      settle({ status: null, signal: child.signalCode, ...captured(), error });
    };
    const interruptionError = (signal: "SIGTERM" | "SIGINT") =>
      Object.assign(new Error(`OpenShell command cancelled by ${signal}`), { code: "ECANCELED" });
    const beginInterruption = (signal: "SIGTERM" | "SIGINT") => {
      if (settled || timedOut || interruptedBy) return;
      interruptedBy = signal;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signalProcessTree(child, signal);
      killHandle = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        forceHandle = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle({
            status: null,
            signal: "SIGKILL",
            ...captured(),
            error: interruptionError(signal),
          });
        }, killGraceMs);
      }, killGraceMs);
    };

    if (opts.signalSource) {
      const forwardTerm = () => beginInterruption("SIGTERM");
      const forwardInt = () => beginInterruption("SIGINT");
      releaseSignals = () => {
        opts.signalSource?.remove("SIGTERM", forwardTerm);
        opts.signalSource?.remove("SIGINT", forwardInt);
      };
      opts.signalSource.add("SIGTERM", forwardTerm);
      opts.signalSource.add("SIGINT", forwardInt);
    }

    child.stdout?.on("data", (chunk: Buffer | string) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => capture("stderr", chunk));
    child.once("error", (error) => {
      if (timedOut) {
        signalProcessTree(child, "SIGKILL");
        settle({
          status: null,
          signal: child.signalCode ?? timeoutSignal,
          ...captured(),
          error: timeoutError(binary, [...args], opts.timeoutMilliseconds as number),
          timedOut: true,
          ...(timeoutSignal ? { timeoutSignal } : {}),
        });
        return;
      }
      if (interruptedBy) {
        signalProcessTree(child, "SIGKILL");
        settle({
          status: null,
          signal: child.signalCode ?? interruptedBy,
          ...captured(),
          error: interruptionError(interruptedBy),
        });
        return;
      }
      settle({ status: null, signal: child.signalCode, ...captured(), error });
    });
    child.once("close", (status, signal) => {
      if (timedOut) {
        signalProcessTree(child, "SIGKILL");
        settle({
          status,
          signal,
          ...captured(),
          error: timeoutError(binary, [...args], opts.timeoutMilliseconds as number),
          timedOut: true,
          ...(timeoutSignal ? { timeoutSignal } : {}),
        });
        return;
      }
      if (interruptedBy) {
        signalProcessTree(child, "SIGKILL");
        settle({
          status: null,
          signal: signal ?? interruptedBy,
          ...captured(),
          error: interruptionError(interruptedBy),
        });
        return;
      }
      settle({ status, signal, ...captured() });
    });
    if (hasInput) {
      child.stdin?.once("error", (error) => {
        if (settled) return;
        signalProcessTree(child, "SIGKILL");
        settle({ status: null, signal: child.signalCode, ...captured(), error });
      });
    }

    if (
      opts.timeoutMilliseconds !== undefined &&
      Number.isFinite(opts.timeoutMilliseconds) &&
      opts.timeoutMilliseconds > 0
    ) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutSignal = opts.timeoutKillSignal ?? "SIGTERM";
        child.unref();
        signalProcessTree(child, timeoutSignal);
        if (timeoutSignal === "SIGKILL") {
          forceHandle = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle({
              status: null,
              signal: "SIGKILL",
              ...captured(),
              error: timeoutError(binary, [...args], opts.timeoutMilliseconds as number),
              timedOut: true,
              timeoutSignal: "SIGKILL",
            });
          }, killGraceMs);
          return;
        }
        killHandle = setTimeout(() => {
          timeoutSignal = "SIGKILL";
          signalProcessTree(child, "SIGKILL");
          forceHandle = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle({
              status: null,
              signal: "SIGKILL",
              ...captured(),
              error: timeoutError(binary, [...args], opts.timeoutMilliseconds as number),
              timedOut: true,
              timeoutSignal: "SIGKILL",
            });
          }, killGraceMs);
        }, killGraceMs);
      }, opts.timeoutMilliseconds);
    }
    if (hasInput) child.stdin?.end(opts.input);
  });
}
