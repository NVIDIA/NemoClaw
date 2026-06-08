// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import type { ArtifactSink } from "./artifacts.ts";
import { redactText } from "./secrets.ts";

export interface ShellProbeRunOptions {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  timeoutMs?: number;
  killGraceMs?: number;
  artifactName?: string;
  redactionValues?: string[];
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

export class ShellProbe {
  private readonly artifacts: ArtifactSink;
  private readonly redact: (text: string, extraValues?: string[]) => string;
  private readonly signal: AbortSignal;

  constructor(deps: ShellProbeDeps) {
    this.artifacts = deps.artifacts;
    this.redact = deps.redact;
    this.signal = deps.signal;
  }

  async run(command: string, options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    if (!command.trim()) {
      throw new Error("shell probe command is required");
    }

    const args = options.args ?? [];
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const redactionValues = options.redactionValues ?? [];
    const redactProbeText = (text: string) => this.redact(redactText(text, redactionValues));
    const redactedCommand = [command, ...args].map(redactProbeText);
    const artifactBase = `shell/${safeArtifactBase(redactProbeText(options.artifactName ?? command))}`;
    const writeArtifacts = async (result: Omit<ShellProbeResult, "artifacts">): Promise<ShellProbeResult["artifacts"]> => ({
      stdout: await this.artifacts.writeText(`${artifactBase}.stdout.txt`, result.stdout),
      stderr: await this.artifacts.writeText(`${artifactBase}.stderr.txt`, result.stderr),
      result: await this.artifacts.writeJson(`${artifactBase}.result.json`, result),
    });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.inheritEnv ? { ...process.env, ...(options.env ?? {}) } : { ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

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

    const abort = () => {
      child.kill("SIGTERM");
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, killGraceMs);
    }, timeoutMs);
    this.signal.addEventListener("abort", abort, { once: true });

    let childResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let childError: unknown;
    try {
      childResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      });
    } catch (error) {
      childError = error;
    } finally {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
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
