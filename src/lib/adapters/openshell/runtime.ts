// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";
import path from "node:path";

import { ROOT } from "../../runner";
import {
  captureOpenshellCommand,
  captureOpenshellCommandAsync,
  captureSandboxSshConfigCommand,
  getInstalledOpenshellVersion,
  runOpenshellCommand,
} from "./client";
import { buildOpenShellSubprocessEnv, resolveOpenshellBinaryOrNull } from "./resolve-shared";
import { OPENSHELL_OPERATION_TIMEOUT_MS, OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

type CommandArgs = string[];

export {
  buildOpenShellRuntimeSelectionEnv,
  replaceOpenShellRuntimeSelectionEnv,
  snapshotOpenShellEnv,
  type OpenShellRuntimeSelection,
} from "./runtime-selection";
export {
  buildOpenShellCommandEnv,
  buildSelectedOpenShellSubprocessEnv,
  withSelectedOpenShellCommandOptions,
} from "./command-argv";

export {
  buildOpenShellSubprocessEnv,
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
};
export { classifyManagedGatewayEndpointBinding } from "./client";
export { runCaptureEx } from "../../runner";

type RunnerOptions = {
  /** Exact canonical executable selected by the caller. */
  openshellBinary?: string;
  env?: NodeJS.ProcessEnv;
  gatewayName?: string;
  replaceEnv?: boolean;
  stdio?: StdioOptions;
  input?: string;
  ignoreError?: boolean;
  includeStderr?: boolean;
  includeStreams?: boolean;
  timeout?: number;
  killSignal?: NodeJS.Signals;
  killProcessTreeOnTimeout?: boolean;
  maxBuffer?: number;
};

let openshellBin: string | null = null;

/** Resolve and cache the OpenShell binary path, exiting if it is not installed. */
export function getOpenshellBinary(): string {
  if (!openshellBin) {
    openshellBin = resolveOpenshellBinaryOrNull();
  }
  if (!openshellBin) {
    console.error("openshell CLI not found. Install OpenShell before using sandbox commands.");
    process.exit(1);
  }
  return openshellBin;
}

/** Run an OpenShell command, inheriting stdio (no output capture). */
export function runOpenshell(args: CommandArgs, opts: RunnerOptions = {}) {
  return runOpenshellCommand(opts.openshellBinary ?? getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    replaceEnv: opts.replaceEnv,
    stdio: opts.stdio,
    input: opts.input,
    ignoreError: opts.ignoreError,
    timeout: opts.timeout,
    killSignal: opts.killSignal,
    killProcessTreeOnTimeout: opts.killProcessTreeOnTimeout,
    maxBuffer: opts.maxBuffer,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

/**
 * Run an OpenShell command and capture its output. `includeStderr` keeps stderr
 * in the captured output even when `ignoreError` is set (needed for probes that
 * must stay non-fatal yet still read status text OpenShell writes to stderr).
 */
export function captureOpenshell(args: CommandArgs, opts: RunnerOptions = {}) {
  return captureOpenshellCommand(opts.openshellBinary ?? getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    replaceEnv: opts.replaceEnv,
    ignoreError: opts.ignoreError,
    includeStderr: opts.includeStderr,
    includeStreams: opts.includeStreams,
    timeout: opts.timeout,
    killSignal: opts.killSignal,
    killProcessTreeOnTimeout: opts.killProcessTreeOnTimeout,
    maxBuffer: opts.maxBuffer,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

/** Capture an OpenShell command while treating an unavailable binary as a recoverable error. */
export function captureResolvedOpenshell(args: CommandArgs, opts: RunnerOptions = {}) {
  const openshell = opts.openshellBinary ?? resolveOpenshellBinaryOrNull();
  if (!openshell) throw new Error("OpenShell is unavailable");
  if (!path.isAbsolute(openshell)) throw new Error("OpenShell executable must be absolute");
  return captureOpenshellCommand(openshell, args, {
    cwd: ROOT,
    env: opts.env,
    replaceEnv: opts.replaceEnv,
    ignoreError: opts.ignoreError,
    includeStderr: opts.includeStderr,
    includeStreams: opts.includeStreams,
    timeout: opts.timeout,
    killSignal: opts.killSignal,
    killProcessTreeOnTimeout: opts.killProcessTreeOnTimeout,
    maxBuffer: opts.maxBuffer,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

/** Capture the SSH config OpenShell emits for a sandbox. */
export function captureSandboxSshConfig(sandboxName: string, opts: RunnerOptions = {}) {
  return captureSandboxSshConfigCommand(getOpenshellBinary(), sandboxName, {
    cwd: ROOT,
    env: opts.env,
    gatewayName: opts.gatewayName,
    replaceEnv: opts.replaceEnv,
    ignoreError: opts.ignoreError,
    includeStreams: opts.includeStreams,
    timeout: opts.timeout,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

/** Resolve the status-probe timeout (ms) from env, falling back to the default. */
export function getStatusProbeTimeoutMs(): number {
  const raw = process.env.NEMOCLAW_STATUS_PROBE_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : OPENSHELL_PROBE_TIMEOUT_MS;
}

/** Async variant of {@link captureOpenshell} for status probes, with a kill grace period. */
export function captureOpenshellForStatus(args: CommandArgs, opts: RunnerOptions = {}) {
  return captureOpenshellCommandAsync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    replaceEnv: opts.replaceEnv,
    ignoreError: opts.ignoreError,
    includeStreams: opts.includeStreams,
    timeout: opts.timeout ?? getStatusProbeTimeoutMs(),
    killGraceMs: 1000,
  });
}

/** Whether a captured command result represents an ETIMEDOUT spawn timeout. */
export function isCommandTimeout(result: { error?: Error }) {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

/** Return the installed OpenShell version, or null when it cannot be determined. */
export function getInstalledOpenshellVersionOrNull(opts: { timeout?: number } = {}): string | null {
  return getInstalledOpenshellVersion(getOpenshellBinary(), {
    cwd: ROOT,
    timeout: opts.timeout,
  });
}
