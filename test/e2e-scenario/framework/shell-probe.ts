// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import type { ArtifactSink } from "./artifacts.ts";
import { redactText } from "./secrets.ts";

export interface ShellProbeRunOptions {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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

function safeArtifactBase(command: string, explicitName?: string): string {
  const raw = explicitName ?? command;
  const safe = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "shell-probe";
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
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
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    this.signal.addEventListener("abort", abort, { once: true });

    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      },
    );

    clearTimeout(timeout);
    this.signal.removeEventListener("abort", abort);

    const redactionValues = options.redactionValues ?? [];
    const redactedStdout = this.redact(redactText(stdout, redactionValues));
    const redactedStderr = this.redact(redactText(stderr, redactionValues));
    const artifactBase = `shell/${safeArtifactBase(command, options.artifactName)}`;
    const result: Omit<ShellProbeResult, "artifacts"> = {
      command: [command, ...args].map((part) => this.redact(redactText(part, redactionValues))),
      exitCode: code,
      signal,
      timedOut,
      stdout: redactedStdout,
      stderr: redactedStderr,
    };
    const artifacts = {
      stdout: await this.artifacts.writeText(`${artifactBase}.stdout.txt`, redactedStdout),
      stderr: await this.artifacts.writeText(`${artifactBase}.stderr.txt`, redactedStderr),
      result: await this.artifacts.writeJson(`${artifactBase}.result.json`, result),
    };
    return { ...result, artifacts };
  }
}
