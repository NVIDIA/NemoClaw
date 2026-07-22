// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { TestProgress, TestProgressCapability } from "../fixtures/progress.ts";
import { redactString } from "../fixtures/redaction.ts";
import {
  projectRawOutputForArtifact,
  type RawArtifactOutputMode,
} from "./bedrock-runtime-compatible-anthropic-artifacts.ts";

const MAX_RAW_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const RAW_COMMAND_OUTPUT_LIMIT_MARKER = "[bedrock raw-command output exceeded safe capture limit]";

interface BoundedOutputCapture {
  readonly buffer: Buffer;
  length: number;
}

function boundedOutputCapture(): BoundedOutputCapture {
  return { buffer: Buffer.allocUnsafe(MAX_RAW_COMMAND_OUTPUT_BYTES), length: 0 };
}

function appendBoundedOutput(capture: BoundedOutputCapture, chunk: Buffer): boolean {
  const copied = chunk.copy(
    capture.buffer,
    capture.length,
    0,
    MAX_RAW_COMMAND_OUTPUT_BYTES - capture.length,
  );
  capture.length += copied;
  return copied === chunk.length;
}

function capturedOutput(capture: BoundedOutputCapture): string {
  return capture.buffer.subarray(0, capture.length).toString("utf8");
}

export interface RawRunResult {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly redactedStdout: string;
  readonly redactedStderr: string;
}

export interface RawRunOptions {
  readonly artifactName: string;
  readonly artifacts: ArtifactSink;
  readonly artifactOutputMode?: RawArtifactOutputMode;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly progress: Pick<TestProgress, "activity" | "event" | "onOutput"> & TestProgressCapability;
  readonly redactionValues?: readonly string[];
  readonly timeoutMs?: number;
}

function progressCommandName(artifactName: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(artifactName)
    ? artifactName
    : "bedrock-raw-command";
}

function emitProgressEvent(progress: RawRunOptions["progress"], label: string): void {
  try {
    progress?.event(label);
  } catch {
    // Progress diagnostics must never change the Bedrock contract result.
  }
}

function redactedCommand(command: readonly string[], values: readonly string[]): string[] {
  return command.map((part) => redactString(part, values));
}

export async function runRawCommand(
  command: string,
  args: readonly string[],
  options: RawRunOptions,
): Promise<RawRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const redactionValues = [...(options.redactionValues ?? [])];
  const progressName = progressCommandName(options.artifactName);
  emitProgressEvent(options.progress, `command ${progressName} started`);
  let child: ReturnType<typeof spawnObservedChild>;
  try {
    child = spawnObservedChild(command, args, {
      activityLabel: `command: ${progressName}`,
      progress: options.progress,
      spawn: {
        cwd: options.cwd ?? REPO_ROOT,
        detached: true,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
  } catch (error) {
    emitProgressEvent(options.progress, `command ${progressName} failed to start`);
    throw error;
  }
  const fullCommand = [command, ...args];
  const stdoutCapture = boundedOutputCapture();
  const stderrCapture = boundedOutputCapture();
  let captureLimitExceeded = false;
  let timedOut = false;
  let spawnError: Error | undefined;

  const killProcessGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  const captureOutput = (capture: BoundedOutputCapture, chunk: Buffer): void => {
    if (captureLimitExceeded || appendBoundedOutput(capture, chunk)) return;
    captureLimitExceeded = true;
    stdoutCapture.length = 0;
    stderrCapture.length = 0;
    emitProgressEvent(
      options.progress,
      `command ${progressName} output exceeded safe capture limit`,
    );
    killProcessGroup("SIGKILL");
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    emitProgressEvent(
      options.progress,
      `command ${progressName} timeout fired after ${timeoutMs}ms`,
    );
    killProcessGroup("SIGTERM");
    setTimeout(() => killProcessGroup("SIGKILL"), 1_000).unref();
  }, timeoutMs);
  timeout.unref();

  child.stdout?.on("data", (chunk: Buffer) => {
    captureOutput(stdoutCapture, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    captureOutput(stderrCapture, chunk);
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  });
  clearTimeout(timeout);
  emitProgressEvent(
    options.progress,
    `command ${progressName} ${timedOut ? "stopped after timeout" : exitCode === 0 ? "passed" : "failed"}`,
  );

  if (spawnError) {
    const message = redactString(spawnError.message, redactionValues);
    throw new Error(`failed to spawn ${redactString(command, redactionValues)}: ${message}`);
  }

  const stdout = captureLimitExceeded
    ? RAW_COMMAND_OUTPUT_LIMIT_MARKER
    : capturedOutput(stdoutCapture);
  const stderr = captureLimitExceeded
    ? RAW_COMMAND_OUTPUT_LIMIT_MARKER
    : capturedOutput(stderrCapture);
  const redactedStdout = redactString(stdout, redactionValues);
  const redactedStderr = redactString(stderr, redactionValues);
  const artifactOutputMode = options.artifactOutputMode ?? "content";
  const artifactStdout = captureLimitExceeded
    ? RAW_COMMAND_OUTPUT_LIMIT_MARKER
    : projectRawOutputForArtifact(redactedStdout, "stdout", artifactOutputMode);
  const artifactStderr = captureLimitExceeded
    ? RAW_COMMAND_OUTPUT_LIMIT_MARKER
    : projectRawOutputForArtifact(redactedStderr, "stderr", artifactOutputMode);
  await options.artifacts.writeText(`raw-shell/${options.artifactName}.stdout.txt`, artifactStdout);
  await options.artifacts.writeText(`raw-shell/${options.artifactName}.stderr.txt`, artifactStderr);
  await options.artifacts.writeJson(`raw-shell/${options.artifactName}.result.json`, {
    command: redactedCommand(fullCommand, redactionValues),
    exitCode,
    signal,
    timedOut,
    captureLimitExceeded,
    stdout: artifactStdout,
    stderr: artifactStderr,
  });

  if (captureLimitExceeded) {
    throw new Error(`command ${progressName} output exceeded safe capture limit`);
  }

  return {
    command: fullCommand,
    exitCode,
    signal,
    timedOut,
    stdout,
    stderr,
    redactedStdout,
    redactedStderr,
  };
}
