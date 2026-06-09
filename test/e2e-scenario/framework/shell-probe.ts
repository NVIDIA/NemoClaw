// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import type { ArtifactSink } from "./artifacts.ts";

/**
 * Bridge-only host shell probe for the Vitest fixture migration.
 *
 * The end state is a shared spawn/evidence helper consumed by both this
 * fixture layer and scenarios/orchestrators; that consolidation is tracked
 * separately. Until it lands, this probe mirrors the hardened shell boundary:
 * trusted descriptors, NUL-byte rejection, explicit env by default, canonical
 * redaction (routed through the single shared entry point), and detached
 * process-group termination for timeout/abort cleanup.
 */

export interface ShellProbeRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  timeoutMs?: number;
  killGraceMs?: number;
  artifactName?: string;
  redactionValues?: string[];
}

const trustedShellCommandBrand: unique symbol = Symbol("TrustedShellCommand");

export interface TrustedShellCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly reason: string;
  readonly [trustedShellCommandBrand]: true;
}

export interface TrustedShellCommandInput {
  command: string;
  args?: string[];
  reason: string;
  validate?: (command: string, args: readonly string[]) => void;
}

export interface ShellProbeResult {
  command: string[];
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

function validateShellToken(value: string, label: string): string {
  if (value.includes("\0")) {
    throw new Error(`shell probe ${label} cannot contain NUL bytes`);
  }
  return value;
}

/**
 * Declares a shell command as trusted at the fixture/helper boundary.
 *
 * Build descriptors from constants or typed fixture helpers. Do not pass
 * scenario, manifest, PR, or other untrusted values as the executable command.
 * Put command-specific argument validation in `validate` when arguments include
 * values derived from scenario data.
 */
export function trustedShellCommand(input: TrustedShellCommandInput): TrustedShellCommand {
  const command = validateShellToken(input.command.trim(), "command");
  if (!command) {
    throw new Error("shell probe command is required");
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("shell probe trusted command reason is required");
  }
  const args = (input.args ?? []).map((arg) => validateShellToken(arg, "argument"));
  input.validate?.(command, args);
  return {
    command,
    args,
    reason,
    [trustedShellCommandBrand]: true,
  };
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
    const redactedCommand = [command, ...args].map(redactProbeText);
    const artifactBase = `shell/${safeArtifactBase(redactProbeText(options.artifactName ?? command))}`;
    const writeArtifacts = async (
      result: Omit<ShellProbeResult, "artifacts">,
    ): Promise<ShellProbeResult["artifacts"]> => ({
      stdout: await this.artifacts.writeText(`${artifactBase}.stdout.txt`, result.stdout),
      stderr: await this.artifacts.writeText(`${artifactBase}.stderr.txt`, result.stderr),
      result: await this.artifacts.writeJson(`${artifactBase}.result.json`, result),
    });
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: options.inheritEnv
        ? { ...process.env, ...(options.env ?? {}) }
        : { ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = child.pid;

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    let killTimer: NodeJS.Timeout | undefined;
    let terminationStarted = false;
    const signalProcessGroup = (signal: NodeJS.Signals) => {
      if (typeof pgid === "number") {
        try {
          process.kill(-pgid, signal);
          return;
        } catch {
          /* fall back to the leader below */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };
    const terminate = () => {
      terminationStarted = true;
      signalProcessGroup("SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        signalProcessGroup("SIGKILL");
      }, killGraceMs);
      killTimer.unref();
    };
    const abort = () => {
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    if (this.signal.aborted) {
      abort();
    } else {
      this.signal.addEventListener("abort", abort, { once: true });
    }

    let childResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let childError: unknown;
    try {
      childResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
    } catch (error) {
      childError = error;
    } finally {
      clearTimeout(timeout);
      if (killTimer && !terminationStarted) clearTimeout(killTimer);
      this.signal.removeEventListener("abort", abort);
    }

    const redactedStdout = redactProbeText(stdout);
    if (childError) {
      const redactedMessage = redactProbeText(errorMessage(childError));
      const redactedStderr = redactProbeText([stderr, redactedMessage].filter(Boolean).join("\n"));
      await writeArtifacts({
        command: redactedCommand,
        exitCode: null,
        signal: null,
        timedOut,
        stdout: redactedStdout,
        stderr: redactedStderr,
      });
      throw redactedError(childError, redactedMessage);
    }

    if (!childResult) {
      throw new Error("shell probe child process did not report a result");
    }

    const redactedStderr = redactProbeText(stderr);
    const result: Omit<ShellProbeResult, "artifacts"> = {
      command: redactedCommand,
      exitCode: childResult.code,
      signal: childResult.signal,
      timedOut,
      stdout: redactedStdout,
      stderr: redactedStderr,
    };
    const artifacts = await writeArtifacts(result);
    return { ...result, artifacts };
  }
}
