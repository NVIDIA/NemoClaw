// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";

interface OpenshellSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnSyncImpl?: typeof spawnSync;
  errorLine?: (message: string) => void;
  exit?: (code: number) => never;
}

export interface RunOpenshellOptions extends OpenshellSpawnOptions {
  stdio?: SpawnSyncOptions["stdio"];
  ignoreError?: boolean;
}

export interface CaptureOpenshellOptions extends OpenshellSpawnOptions {
  ignoreError?: boolean;
}

export interface CaptureOpenshellResult {
  status: number;
  output: string;
}

// eslint-disable-next-line no-control-regex
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
  });
  if (result.error) {
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
  });
  if (result.error) {
    return handleSpawnError(binary, args, result.error, opts);
  }
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ""}${opts.ignoreError ? "" : result.stderr || ""}`.trim(),
  };
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
