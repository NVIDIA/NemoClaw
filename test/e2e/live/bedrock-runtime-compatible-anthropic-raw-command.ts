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

const MAX_RAW_OUTPUT_BYTES = 10 * 1024 * 1024;
const TRUNCATED_OUTPUT_MARKER = "\n[raw command output truncated at safe capture limit]";

function appendBoundedOutput(
  output: Buffer,
  chunk: Buffer,
): { output: Buffer; truncated: boolean } {
  const remaining = Math.max(0, MAX_RAW_OUTPUT_BYTES - output.length);
  return {
    output: Buffer.concat([output, chunk.subarray(0, remaining)]),
    truncated: chunk.length > remaining,
  };
}

function renderBoundedOutput(output: Buffer, truncated: boolean): string {
  return `${output.toString("utf8")}${truncated ? TRUNCATED_OUTPUT_MARKER : ""}`;
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
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let stdoutTruncated = false;
  let stderrTruncated = false;
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
    const capture = appendBoundedOutput(stdoutBuffer, chunk);
    stdoutBuffer = capture.output;
    stdoutTruncated ||= capture.truncated;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const capture = appendBoundedOutput(stderrBuffer, chunk);
    stderrBuffer = capture.output;
    stderrTruncated ||= capture.truncated;
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

  const stdout = renderBoundedOutput(stdoutBuffer, stdoutTruncated);
  const stderr = renderBoundedOutput(stderrBuffer, stderrTruncated);
  const redactedStdout = redactString(stdout, redactionValues);
  const redactedStderr = redactString(stderr, redactionValues);
  const artifactOutputMode = options.artifactOutputMode ?? "content";
  const artifactStdout = projectRawOutputForArtifact(redactedStdout, "stdout", artifactOutputMode);
  const artifactStderr = projectRawOutputForArtifact(redactedStderr, "stderr", artifactOutputMode);
  await options.artifacts.writeText(`raw-shell/${options.artifactName}.stdout.txt`, artifactStdout);
  await options.artifacts.writeText(`raw-shell/${options.artifactName}.stderr.txt`, artifactStderr);
  await options.artifacts.writeJson(`raw-shell/${options.artifactName}.result.json`, {
    command: redactedCommand(fullCommand, redactionValues),
    exitCode,
    signal,
    timedOut,
    stdout: artifactStdout,
    stderr: artifactStderr,
  });

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
