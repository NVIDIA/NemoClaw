// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import type { TestContext } from "vitest";

import { superviseChild } from "./process-supervisor.ts";

export type SupervisedProcessOwner = Pick<TestContext, "onTestFinished" | "signal">;

export interface RunSupervisedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  maxOutputBytesPerStream: number;
  owner?: SupervisedProcessOwner;
  timeoutMs: number;
}

export interface SupervisedProcessResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

/** Runs a detached test fixture with bounded output and process-group cleanup. */
export function runSupervisedProcess(
  file: string,
  args: readonly string[],
  options: RunSupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  options.owner?.signal.throwIfAborted();
  let stdout = "";
  let stderr = "";
  let outputError: Error | undefined;
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const finishController = new AbortController();
  const append = (current: string, chunk: string, stream: string): string => {
    const next = current + chunk;
    const limitError =
      !outputError && Buffer.byteLength(next, "utf8") > options.maxOutputBytesPerStream
        ? new Error(`${stream} exceeded the process output limit`)
        : undefined;
    outputError ??= limitError;
    if (limitError) finishController.abort();
    return outputError ? current : next;
  };
  const signal = options.owner
    ? AbortSignal.any([options.owner.signal, finishController.signal])
    : finishController.signal;
  const resultPromise = superviseChild(child, {
    killGraceMs: options.killGraceMs ?? 100,
    onStderr: (chunk) => {
      stderr = append(stderr, chunk, "stderr");
    },
    onStdout: (chunk) => {
      stdout = append(stdout, chunk, "stdout");
    },
    signal,
    timeoutMs: options.timeoutMs,
  }).then((result): SupervisedProcessResult => {
    const error = outputError ?? result.spawnError ?? result.cleanupError;
    return {
      ...(error ? { error } : {}),
      signal: result.signal,
      status: result.signal ? null : error ? -1 : result.exitCode,
      stderr,
      stdout,
      timedOut: result.timedOut,
    };
  });
  options.owner?.onTestFinished(async () => {
    finishController.abort();
    await resultPromise;
  });
  return resultPromise;
}
