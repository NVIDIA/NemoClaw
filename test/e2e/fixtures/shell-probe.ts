// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import type { ArtifactSink } from "./artifacts.ts";
import { superviseChild } from "./shell/supervisor.ts";
import type { TrustedShellCommand } from "./shell/trusted-command.ts";

/**
 * Fixture-flavoured host shell probe.
 *
 * The lifecycle boundary (detached process-group cleanup, SIGTERM ->
 * SIGKILL escalation, timeout, AbortSignal) is owned by
 * fixtures/shell/supervisor.ts and shared with the phase orchestrator
 * and probe helpers. The trusted-command brand + NUL-byte guard live
 * in fixtures/shell/trusted-command.ts. This file layers the
 * fixture-specific policy on top: redaction at the canonical entry
 * point, artefact persistence, and explicit-env-by-default.
 */

export interface ShellProbeRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  artifactName?: string;
  redactionValues?: string[];
  /** Retain at most the last N bytes from each output stream. */
  captureLimitBytes?: number;
  /** Timestamp-only output observer; chunk contents never cross this boundary. */
  onOutput?: (event: ShellProbeOutputEvent) => void;
}

export interface ShellProbeOutputEvent {
  stream: "stdout" | "stderr";
  atMs: number;
}

export type { TrustedShellCommand, TrustedShellCommandInput } from "./shell/trusted-command.ts";
export { trustedShellCommand } from "./shell/trusted-command.ts";

export interface ShellProbeResult {
  command: string[];
  /** Wall-clock command duration, persisted for CI bottleneck analysis. */
  durationMs?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  artifacts: {
    stdout: string;
    stderr: string;
    result: string;
  };
}

export interface ShellProbeDeps {
  artifacts: ArtifactSink;
  redact: (text: string, extraValues?: string[]) => string;
  signal: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 1_000;

function safeArtifactBase(raw: string): string {
  const safe = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "shell-probe";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactedError(error: unknown, message: string): Error {
  const next = new Error(message);
  if (error instanceof Error) {
    next.name = error.name;
  }
  return next;
}

interface TextCapture {
  append(chunk: string): void;
  value(): {
    droppedBytes: number;
    limitBytes?: number;
    text: string;
  };
}

function createTextCapture(limitBytes: number | undefined): TextCapture {
  if (limitBytes === undefined) {
    let text = "";
    return {
      append(chunk) {
        text += chunk;
      },
      value() {
        return { droppedBytes: 0, text };
      },
    };
  }
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new Error("captureLimitBytes must be a positive safe integer");
  }

  let droppedBytes = 0;
  let tail = Buffer.alloc(0);
  return {
    append(chunk) {
      const incoming = Buffer.from(chunk, "utf8");
      const combined = tail.length === 0 ? incoming : Buffer.concat([tail, incoming]);
      if (combined.length <= limitBytes) {
        tail = combined;
        return;
      }
      const overflow = combined.length - limitBytes;
      let retainedStart = overflow;
      while (retainedStart < combined.length && (combined[retainedStart]! & 0xc0) === 0x80) {
        retainedStart += 1;
      }
      droppedBytes += retainedStart;
      tail = Buffer.from(combined.subarray(retainedStart));
    },
    value() {
      return { droppedBytes, limitBytes, text: tail.toString("utf8") };
    },
  };
}

function redactTruncatedSecretPrefix(text: string, redactionValues: string[]): string {
  let fragmentLength = 0;
  for (const value of redactionValues) {
    const maxLength = Math.min(value.length - 1, text.length);
    for (let length = maxLength; length > fragmentLength; length -= 1) {
      if (text.startsWith(value.slice(-length))) {
        fragmentLength = length;
        break;
      }
    }
  }
  return fragmentLength > 0 ? `[REDACTED]${text.slice(fragmentLength)}` : text;
}

export class ShellProbe {
  private readonly artifacts: ArtifactSink;
  private readonly redact: (text: string, extraValues?: string[]) => string;
  private readonly signal: AbortSignal;

  constructor(deps: ShellProbeDeps) {
    this.artifacts = deps.artifacts;
    this.redact = deps.redact;
    this.signal = deps.signal;
  }

  async run(
    trustedCommand: TrustedShellCommand,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const command = trustedCommand.command;
    const args = [...trustedCommand.args];
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const redactionValues = options.redactionValues ?? [];
    const enforcedValues = [
      ...new Set(redactionValues.filter((value) => value && value.length > 0)),
    ].sort((a, b) => b.length - a.length);
    const enforceLocalRedaction = (text: string): string => {
      let out = text;
      for (const value of enforcedValues) {
        out = out.split(value).join("[REDACTED]");
      }
      return out;
    };
    const redactProbeText = (text: string) =>
      this.redact(enforcedValues.length > 0 ? enforceLocalRedaction(text) : text, redactionValues);
    const renderCapturedText = (capture: TextCapture): string => {
      const { droppedBytes, limitBytes, text } = capture.value();
      const boundarySafeText =
        droppedBytes > 0 ? redactTruncatedSecretPrefix(text, enforcedValues) : text;
      const redacted = redactProbeText(boundarySafeText);
      return droppedBytes > 0
        ? `[shell-probe omitted ${droppedBytes} earlier bytes; showing up to the last ${limitBytes} bytes]\n${redacted}`
        : redacted;
    };
    const redactedCommand = [command, ...args].map(redactProbeText);
    const artifactBase = `shell/${safeArtifactBase(redactProbeText(options.artifactName ?? command))}`;
    const writeArtifacts = async (
      result: Omit<ShellProbeResult, "artifacts">,
    ): Promise<ShellProbeResult["artifacts"]> => ({
      stdout: await this.artifacts.writeText(`${artifactBase}.stdout.txt`, result.stdout),
      stderr: await this.artifacts.writeText(`${artifactBase}.stderr.txt`, result.stderr),
      result: await this.artifacts.writeJson(`${artifactBase}.result.json`, result),
    });

    const stdout = createTextCapture(options.captureLimitBytes);
    const stderr = createTextCapture(options.captureLimitBytes);
    const startedAtMs = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: { ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const supervised = await superviseChild(child, {
      timeoutMs,
      killGraceMs,
      signal: this.signal,
      onStdout: (chunk) => {
        stdout.append(chunk);
        try {
          options.onOutput?.({ stream: "stdout", atMs: Date.now() });
        } catch {
          // Test instrumentation must not change command execution.
        }
      },
      onStderr: (chunk) => {
        stderr.append(chunk);
        try {
          options.onOutput?.({ stream: "stderr", atMs: Date.now() });
        } catch {
          // Test instrumentation must not change command execution.
        }
      },
    });

    const redactedStdout = renderCapturedText(stdout);
    const redactedStderr = renderCapturedText(stderr);
    const durationMs = Date.now() - startedAtMs;
    if (supervised.spawnError) {
      const redactedMessage = redactProbeText(errorMessage(supervised.spawnError));
      const stderrWithError = [redactedStderr, redactedMessage].filter(Boolean).join("\n");
      await writeArtifacts({
        command: redactedCommand,
        durationMs,
        exitCode: null,
        signal: null,
        timedOut: supervised.timedOut,
        stdout: redactedStdout,
        stderr: stderrWithError,
      });
      throw redactedError(supervised.spawnError, redactedMessage);
    }

    const result: Omit<ShellProbeResult, "artifacts"> = {
      command: redactedCommand,
      durationMs,
      exitCode: supervised.exitCode,
      signal: supervised.signal,
      timedOut: supervised.timedOut,
      stdout: redactedStdout,
      stderr: redactedStderr,
    };
    const artifacts = await writeArtifacts(result);
    return { ...result, artifacts };
  }
}
