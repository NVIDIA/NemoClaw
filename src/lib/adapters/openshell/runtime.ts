// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";

import { ROOT } from "../../runner";
import {
  captureOpenshellCommand,
  captureOpenshellCommandAsync,
  captureSandboxSshConfigCommand,
  getInstalledOpenshellVersion,
  runOpenshellCommand,
} from "./client";
import { resolveOpenshell } from "./resolve";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

type CommandArgs = string[];

type RunnerOptions = {
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  input?: string;
  ignoreError?: boolean;
  timeout?: number;
};

let openshellBin: string | null = null;

export function getOpenshellBinary(): string {
  if (!openshellBin) {
    openshellBin = resolveOpenshell();
  }
  if (!openshellBin) {
    console.error("openshell CLI not found. Install OpenShell before using sandbox commands.");
    process.exit(1);
  }
  return openshellBin;
}

export function runOpenshell(args: CommandArgs, opts: RunnerOptions = {}) {
  return runOpenshellCommand(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    stdio: opts.stdio,
    input: opts.input,
    ignoreError: opts.ignoreError,
    timeout: opts.timeout,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

export function captureOpenshell(args: CommandArgs, opts: RunnerOptions = {}) {
  return captureOpenshellCommand(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    ignoreError: opts.ignoreError,
    timeout: opts.timeout,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

export function captureSandboxSshConfig(sandboxName: string, opts: RunnerOptions = {}) {
  return captureSandboxSshConfigCommand(getOpenshellBinary(), sandboxName, {
    cwd: ROOT,
    env: opts.env,
    ignoreError: opts.ignoreError,
    timeout: opts.timeout,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

export function getStatusProbeTimeoutMs(): number {
  const raw = process.env.NEMOCLAW_STATUS_PROBE_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : OPENSHELL_PROBE_TIMEOUT_MS;
}

export function captureOpenshellForStatus(args: CommandArgs, opts: RunnerOptions = {}) {
  return captureOpenshellCommandAsync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    ignoreError: opts.ignoreError,
    timeout: opts.timeout ?? getStatusProbeTimeoutMs(),
    killGraceMs: 1000,
  });
}

export function isCommandTimeout(result: { error?: Error }) {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

export function getInstalledOpenshellVersionOrNull(opts: { timeout?: number } = {}): string | null {
  return getInstalledOpenshellVersion(getOpenshellBinary(), {
    cwd: ROOT,
    timeout: opts.timeout,
  });
}
