// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type StdioOptions } from "node:child_process";
import { isStdinTty } from "./stdin";
import {
  superviseProcessSession,
  type ProcessSessionChild,
  type ProcessSessionSignals,
} from "./process-session";

/** The subset of a child-process result the delivery classifier reads. */
export type CapturedProcessOutcome = {
  error?: Error;
  status: number | null;
  signal?: NodeJS.Signals | null;
};

export type CapturedProcessResult = CapturedProcessOutcome & {
  stderr: string;
  stdout: string;
};

type CapturedProcessReadable = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

type CaptureBudget = {
  bytes: number;
  overflowed: boolean;
};

export type CapturedProcessChild = ProcessSessionChild & {
  stderr: CapturedProcessReadable | null;
  stdout: CapturedProcessReadable | null;
};

export type CapturedProcessSpawner = (
  binary: string,
  args: readonly string[],
  stdio: StdioOptions,
) => CapturedProcessChild;

export type CapturedProcessRunDeps = {
  signalSource?: ProcessSessionSignals;
  spawnChild?: CapturedProcessSpawner;
};

const DEFAULT_CAPTURE_LIMIT_BYTES = 64 * 1024 * 1024;

const defaultCapturedProcessSpawner: CapturedProcessSpawner = (binary, args, stdio) =>
  spawn(binary, [...args], { stdio }) as unknown as CapturedProcessChild;

function captureProcessStream(
  stream: CapturedProcessReadable | null,
  child: CapturedProcessChild,
  chunks: Buffer[],
  maxBufferBytes: number,
  budget: CaptureBudget,
  setOverflowError: (error: Error) => void,
): void {
  stream?.on("data", (chunk) => {
    if (budget.overflowed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const nextSize = budget.bytes + data.byteLength;
    if (nextSize > maxBufferBytes) {
      budget.overflowed = true;
      setOverflowError(
        Object.assign(
          new Error(`agent output exceeded the ${maxBufferBytes}-byte combined capture limit`),
          { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
        ),
      );
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      return;
    }
    budget.bytes = nextSize;
    chunks.push(data);
  });
}

/**
 * Capture one agent dispatch while the shared sandbox exec supervisor forwards
 * host termination signals to OpenShell and waits for the child to exit.
 */
export async function runCapturedProcess(
  binary: string,
  args: readonly string[],
  options: {
    maxBufferBytes?: number;
    stdinIsTty?: boolean;
  } = {},
  deps: CapturedProcessRunDeps = {},
): Promise<CapturedProcessResult> {
  const stderrChunks: Buffer[] = [];
  const stdoutChunks: Buffer[] = [];
  const captureBudget: CaptureBudget = { bytes: 0, overflowed: false };
  let overflowError: Error | undefined;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_CAPTURE_LIMIT_BYTES;
  const spawnChild = deps.spawnChild ?? defaultCapturedProcessSpawner;
  const result = await superviseProcessSession(() => {
    const child = spawnChild(
      binary,
      args,
      capturedProcessStdio(options.stdinIsTty ?? isStdinTty()),
    );
    const setOverflowError = (error: Error) => {
      overflowError ??= error;
    };
    captureProcessStream(
      child.stdout,
      child,
      stdoutChunks,
      maxBufferBytes,
      captureBudget,
      setOverflowError,
    );
    captureProcessStream(
      child.stderr,
      child,
      stderrChunks,
      maxBufferBytes,
      captureBudget,
      setOverflowError,
    );
    return child;
  }, deps.signalSource);
  try {
    return {
      status: result.status,
      signal: result.signal,
      ...(result.error || overflowError ? { error: result.error ?? overflowError } : {}),
      stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
    };
  } finally {
    result.releaseSignals?.();
  }
}

/**
 * Stdio for a non-interactive agent dispatch. An interactive terminal is
 * withheld from fd 0; a genuine pipe or redirect is still forwarded so
 * scripted stdin keeps working.
 */
export function capturedProcessStdio(stdinIsTty: boolean = isStdinTty()): StdioOptions {
  return [stdinIsTty ? "ignore" : "inherit", "pipe", "pipe"];
}
