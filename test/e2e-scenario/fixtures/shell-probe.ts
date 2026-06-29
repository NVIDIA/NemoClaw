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
  inheritEnv?: boolean;
  timeoutMs?: number;
  killGraceMs?: number;
  artifactName?: string;
  redactionValues?: string[];
}

export type { TrustedShellCommand, TrustedShellCommandInput } from "./shell/trusted-command.ts";
export { trustedShellCommand } from "./shell/trusted-command.ts";

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

    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: options.inheritEnv
        ? { ...process.env, ...(options.env ?? {}) }
        : { ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const supervised = await superviseChild(child, {
      timeoutMs,
      killGraceMs,
      signal: this.signal,
      onStdout: (chunk) => {
        stdout += chunk;
      },
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });

    const redactedStdout = redactProbeText(stdout);
    if (supervised.spawnError) {
      const redactedMessage = redactProbeText(errorMessage(supervised.spawnError));
      const redactedStderr = redactProbeText([stderr, redactedMessage].filter(Boolean).join("\n"));
      await writeArtifacts({
        command: redactedCommand,
        exitCode: null,
        signal: null,
        timedOut: supervised.timedOut,
        stdout: redactedStdout,
        stderr: redactedStderr,
      });
      throw redactedError(supervised.spawnError, redactedMessage);
    }

    const redactedStderr = redactProbeText(stderr);
    const result: Omit<ShellProbeResult, "artifacts"> = {
      command: redactedCommand,
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
