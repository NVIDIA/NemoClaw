// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

export type OpenshellSpawnSync = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export type OpenshellSpawn = typeof spawn;

interface OpenshellSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  ignoreError?: boolean;
  spawnSyncImpl?: OpenshellSpawnSync;
  errorLine?: (message: string) => void;
  exit?: (code: number) => never;
}

export interface RunOpenshellOptions extends OpenshellSpawnOptions {
  stdio?: SpawnSyncOptions["stdio"];
}

export interface CaptureOpenshellOptions extends OpenshellSpawnOptions {}

export interface CaptureOpenshellAsyncOptions extends CaptureOpenshellOptions {
  killGraceMs?: number;
  spawnImpl?: OpenshellSpawn;
}

export interface CaptureOpenshellResult {
  status: number | null;
  output: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value = ""): string {
  return String(value).replace(ANSI_RE, "");
}

export function parseVersionFromText(value = ""): string | null {
  const match = String(value || "").match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return match ? match[1] : null;
}

export function versionGte(left = "0.0.0", right = "0.0.0"): boolean {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function handleSpawnError(
  binary: string,
  args: string[],
  error: Error,
  opts: OpenshellSpawnOptions,
): never {
  const command = [binary, ...args].join(" ");
  (opts.errorLine ?? console.error)(`  Failed to start ${command}: ${error.message}`);
  return (opts.exit ?? ((code) => process.exit(code)))(1);
}

function isIgnoredTimeout(error: Error, opts: OpenshellSpawnOptions): boolean {
  return opts.ignoreError === true && (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

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

export function runOpenshellCommand(
  binary: string,
  args: string[],
  opts: RunOpenshellOptions = {},
): SpawnSyncReturns<string> {
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(binary, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: opts.stdio ?? "inherit",
    timeout: opts.timeout,
  });
  if (result.error) {
    if (isIgnoredTimeout(result.error, opts)) {
      return result;
    }
    return handleSpawnError(binary, args, result.error, opts);
  }
  if (result.status !== 0 && !opts.ignoreError) {
    (opts.errorLine ?? console.error)(
      `  Command failed (exit ${result.status}): openshell ${args.join(" ")}`,
    );
    return (opts.exit ?? ((code) => process.exit(code)))(result.status || 1);
  }
  return result;
}

export function captureOpenshellCommand(
  binary: string,
  args: string[],
  opts: CaptureOpenshellOptions = {},
): CaptureOpenshellResult {
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(binary, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout,
  });
  if (result.error) {
    if (isIgnoredTimeout(result.error, opts)) {
      return {
        status: result.status,
        output: `${result.stdout || ""}${opts.ignoreError ? "" : result.stderr || ""}`.trim(),
        error: result.error,
        signal: result.signal,
      };
    }
    return handleSpawnError(binary, args, result.error, opts);
  }
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ""}${opts.ignoreError ? "" : result.stderr || ""}`.trim(),
  };
}

export function captureOpenshellCommandAsync(
  binary: string,
  args: string[],
  opts: CaptureOpenshellAsyncOptions = {},
): Promise<CaptureOpenshellResult> {
  const spawnImpl = opts.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const child = spawnImpl(binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let capturedError: Error | undefined;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
    };

    const buildOutput = () => `${stdout}${opts.ignoreError ? "" : stderr}`.trim();

    const settle = (
      status: number | null,
      signal: NodeJS.Signals | null,
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        status: status ?? (timedOut ? null : 1),
        output: buildOutput(),
        ...(error ? { error } : {}),
        signal,
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      capturedError = error;
      settle(1, null, error);
    });
    child.on("close", (status, signal) => {
      settle(status, signal, capturedError);
    });

    if (opts.timeout && opts.timeout > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        capturedError = timeoutError(binary, args, opts.timeout as number);
        child.unref();
        signalProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          signalProcessTree(child, "SIGKILL");
          forceTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle(null, "SIGKILL", capturedError);
          }, opts.killGraceMs ?? 1000);
        }, opts.killGraceMs ?? 1000);
      }, opts.timeout);
    }
  });
}

export function getInstalledOpenshellVersion(
  binary: string,
  opts: CaptureOpenshellOptions = {},
): string | null {
  const versionResult = captureOpenshellCommand(binary, ["--version"], {
    ...opts,
    ignoreError: true,
  });
  return parseVersionFromText(versionResult.output);
}
