// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";

import {
  captureOpenshellCommandAsyncResult,
  type OpenshellAsyncCaptureSignalSource,
  type OpenshellSpawn,
} from "./async-capture";

export {
  captureOpenshellCommandAsyncResult,
  type OpenshellSpawn,
  type OpenshellAsyncCaptureSignalSource,
  type OpenshellAsyncCaptureLifecycleOptions,
  type OpenshellAsyncCaptureLifecycleResult,
} from "./async-capture";

import { redirectInheritedChildStdoutToStderr } from "../../cli/stdout-guard";
import { buildSubprocessEnv } from "../../subprocess-env";
import { processTreeBoundedOpenshellInvocation } from "./process-tree-timeout";
import { captureSandboxSshConfig } from "./sandbox-ssh-config-capture";
import { classifyManagedGatewayEndpointBinding } from "../../../../nemoclaw/dist/shared/openshell-gateway-endpoint-boundary.cjs";

export { classifyManagedGatewayEndpointBinding };
export { buildSelectedOpenShellSubprocessEnv } from "./command-argv";
export type { OpenShellRuntimeSelection } from "./runtime-selection";

export { isOpenShellSandboxPolicyCredentialFree } from "./policy-boundary";

export { openshellSandboxSshHost, resolveOpenshellSandboxSshHost } from "./sandbox-ssh-host";

export type OpenshellSpawnSync = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

interface OpenshellSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  replaceEnv?: boolean;
  timeout?: number;
  killProcessTreeOnTimeout?: boolean;
  ignoreError?: boolean;
  spawnSyncImpl?: OpenshellSpawnSync;
  errorLine?: (message: string) => void;
  exit?: (code: number) => never;
}

function openshellSpawnEnv(opts: OpenshellSpawnOptions): NodeJS.ProcessEnv {
  const explicitEnv = Object.fromEntries(
    Object.entries(opts.env ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return opts.replaceEnv ? explicitEnv : buildSubprocessEnv(explicitEnv);
}

export interface RunOpenshellOptions extends OpenshellSpawnOptions {
  stdio?: SpawnSyncOptions["stdio"];
  input?: string;
  killSignal?: SpawnSyncOptions["killSignal"];
  maxBuffer?: number;
}

export interface CaptureOpenshellOptions extends OpenshellSpawnOptions {
  includeStderr?: boolean;
  includeStreams?: boolean;
  killSignal?: SpawnSyncOptions["killSignal"];
  maxBuffer?: number;
}

export interface CaptureOpenshellAsyncOptions extends Omit<CaptureOpenshellOptions, "maxBuffer"> {
  signalSource?: OpenshellAsyncCaptureSignalSource;
  outputLimitBytes?: number;
  killGraceMs?: number;
  spawnImpl?: OpenshellSpawn;
}

export interface CaptureSandboxSshConfigOptions extends CaptureOpenshellOptions {
  /**
   * Gateway the sandbox is recorded against (`resolveSandboxGatewayName`).
   * `sandbox get` and `sandbox ssh-config` resolve against OpenShell's mutable
   * current selection when no gateway is given, so a caller that knows the
   * sandbox's own binding must pass it — otherwise the lookup can land on a
   * sibling gateway and report the sandbox as missing (#7429). Omitted keeps
   * the ambient-selection behavior for callers that have no binding to supply.
   */
  gatewayName?: string;
}

export interface CaptureOpenshellResult {
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value = ""): string {
  return String(value).replace(ANSI_RE, "");
}

export type ManagedGatewayEndpointBinding =
  import("../../../../nemoclaw/dist/shared/openshell-gateway-endpoint-boundary.cjs").ManagedGatewayEndpointBinding;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEMVER_PATTERN = /(?:^|[^0-9.])([0-9]+\.[0-9]+\.[0-9]+)(?![0-9.])/;

export function parseVersionFromText(value = "", versionCommand?: string): string | null {
  const text = String(value || "");
  const commandToken = versionCommand?.trim().split(/\s+/, 1)[0] ?? "";
  const executable = commandToken.split("/").pop() ?? "";
  if (executable) {
    const executablePattern = new RegExp(`\\b${escapeRegExp(executable)}\\b`, "i");
    let executableSeen = false;
    for (const line of text.split(/\r?\n/)) {
      const executableMatch = executablePattern.exec(line);
      if (!executableMatch) continue;
      executableSeen = true;
      const versionMatch = line
        .slice(executableMatch.index + executableMatch[0].length)
        .match(SEMVER_PATTERN);
      if (versionMatch) return versionMatch[1];
    }
    if (executableSeen) return null;
  }

  const match = text.match(SEMVER_PATTERN);
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
  _binary: string,
  _args: string[],
  error: Error,
  opts: OpenshellSpawnOptions,
): never {
  (opts.errorLine ?? console.error)(`  Failed to start OpenShell command: ${error.message}`);
  return (opts.exit ?? ((code) => process.exit(code)))(1);
}

function isIgnoredTimeout(error: Error, opts: OpenshellSpawnOptions): boolean {
  return opts.ignoreError === true && (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

function isIgnoredBufferOverflow(error: Error, opts: OpenshellSpawnOptions): boolean {
  return opts.ignoreError === true && (error as NodeJS.ErrnoException).code === "ENOBUFS";
}

function isIgnoredRunError(error: Error, opts: RunOpenshellOptions): boolean {
  return isIgnoredTimeout(error, opts) || isIgnoredBufferOverflow(error, opts);
}

function isIgnoredCaptureError(error: Error, opts: CaptureOpenshellOptions): boolean {
  return isIgnoredTimeout(error, opts) || isIgnoredBufferOverflow(error, opts);
}

function shouldIncludeStderr(opts: CaptureOpenshellOptions): boolean {
  return opts.includeStderr === true || opts.ignoreError !== true;
}

function captureOutput(result: SpawnSyncReturns<string>, opts: CaptureOpenshellOptions): string {
  return `${result.stdout || ""}${shouldIncludeStderr(opts) ? result.stderr || "" : ""}`.trim();
}

function maybeCapturedStreams(
  stdout: string,
  stderr: string,
  opts: CaptureOpenshellOptions,
): Pick<CaptureOpenshellResult, "stdout" | "stderr"> {
  return opts.includeStreams === true ? { stdout, stderr } : {};
}

export function runOpenshellCommand(
  binary: string,
  args: string[],
  opts: RunOpenshellOptions = {},
): SpawnSyncReturns<string> {
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const bounded = processTreeBoundedOpenshellInvocation(binary, args, opts);
  const result = spawnSyncImpl(bounded.binary, bounded.args, {
    cwd: opts.cwd,
    env: openshellSpawnEnv(opts),
    encoding: "utf-8",
    stdio: redirectInheritedChildStdoutToStderr(opts.stdio ?? "inherit"),
    input: opts.input,
    timeout: opts.timeout,
    killSignal: bounded.killSignal,
    maxBuffer: opts.maxBuffer,
  });
  if (result.error) {
    if (isIgnoredRunError(result.error, opts)) {
      return result;
    }
    return handleSpawnError(binary, args, result.error, opts);
  }
  if (result.status !== 0 && !opts.ignoreError) {
    (opts.errorLine ?? console.error)(`  OpenShell command failed (exit ${result.status})`);
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
  const bounded = processTreeBoundedOpenshellInvocation(binary, args, opts);
  const result = spawnSyncImpl(bounded.binary, bounded.args, {
    cwd: opts.cwd,
    env: openshellSpawnEnv(opts),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout,
    killSignal: bounded.killSignal,
    maxBuffer: opts.maxBuffer,
  });
  if (result.error) {
    if (isIgnoredCaptureError(result.error, opts)) {
      return {
        status: result.status,
        output: captureOutput(result, opts),
        ...maybeCapturedStreams(result.stdout || "", result.stderr || "", opts),
        error: result.error,
        signal: result.signal,
      };
    }
    return handleSpawnError(binary, args, result.error, opts);
  }
  return {
    status: result.status ?? (result.signal ? null : 1),
    output: captureOutput(result, opts),
    ...maybeCapturedStreams(result.stdout || "", result.stderr || "", opts),
    ...(result.signal ? { signal: result.signal } : {}),
  };
}

export function captureSandboxSshConfigCommand(
  binary: string,
  sandboxName: string,
  opts: CaptureSandboxSshConfigOptions = {},
): CaptureOpenshellResult {
  const { gatewayName, ...spawnOpts } = opts;
  return captureSandboxSshConfig(sandboxName, gatewayName, (args, { includeStderr }) =>
    captureOpenshellCommand(binary, args, {
      ...spawnOpts,
      ...(includeStderr ? { ignoreError: true, includeStderr: true } : {}),
    }),
  );
}

export function captureOpenshellCommandAsync(
  binary: string,
  args: string[],
  opts: CaptureOpenshellAsyncOptions = {},
): Promise<CaptureOpenshellResult> {
  return captureOpenshellCommandAsyncResult(binary, args, {
    cwd: opts.cwd,
    environment: openshellSpawnEnv(opts),
    killGraceMs: opts.killGraceMs,
    spawnImpl: opts.spawnImpl,
    timeoutKillSignal:
      opts.killSignal === "SIGTERM" || opts.killSignal === "SIGKILL" ? opts.killSignal : undefined,
    timeoutMilliseconds: opts.timeout,
    outputLimitBytes: opts.outputLimitBytes,
    signalSource: opts.signalSource,
  }).then((result) => ({
    status: result.status ?? (result.timedOut ? null : 1),
    output: `${result.stdout}${shouldIncludeStderr(opts) ? result.stderr : ""}`.trim(),
    ...maybeCapturedStreams(result.stdout, result.stderr, opts),
    ...(result.error ? { error: result.error } : {}),
    signal: result.signal,
  }));
}

export function getInstalledOpenshellVersion(
  binary: string,
  opts: CaptureOpenshellOptions = {},
): string | null {
  const versionResult = captureOpenshellCommand(binary, ["--version"], {
    ...opts,
    ignoreError: true,
  });
  return parseVersionFromText(versionResult.output, binary);
}
