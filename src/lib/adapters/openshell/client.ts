// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ChildProcess,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from "node:child_process";

import { redirectInheritedChildStdoutToStderr } from "../../cli/stdout-guard";
import { buildSubprocessEnv } from "../../subprocess-env";
import { processTreeBoundedOpenshellInvocation } from "./process-tree-timeout";
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

export type OpenshellSpawn = typeof spawn;

export type OpenshellAsyncCaptureSignalSource = {
  add: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
  remove: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
};

export type OpenshellAsyncCaptureLifecycleOptions = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  /** Nonempty input selects a pipe and is always ended. Empty input uses an ignored stdin. */
  input?: string;
  killGraceMs?: number;
  outputLimitBytes?: number;
  signalSource?: OpenshellAsyncCaptureSignalSource;
  spawnImpl?: OpenshellSpawn;
  timeoutKillSignal?: "SIGTERM" | "SIGKILL";
  timeoutMilliseconds?: number;
}>;

export type OpenshellAsyncCaptureLifecycleResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  timeoutSignal?: NodeJS.Signals;
}>;

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

export interface CaptureOpenshellAsyncOptions extends CaptureOpenshellOptions {
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

/**
 * Insert `-g <gateway>` after the subcommand pair, matching the placement
 * `gatewayScopedArgs` already uses in `actions/sandbox/gateway-state.ts`.
 * Duplicated rather than imported: an adapter must not depend on the actions
 * layer.
 */
function gatewayScopedArgs(args: string[], gatewayName?: string): string[] {
  if (!gatewayName) return args;
  return [...args.slice(0, 2), "-g", gatewayName, ...args.slice(2)];
}

export function captureSandboxSshConfigCommand(
  binary: string,
  sandboxName: string,
  opts: CaptureSandboxSshConfigOptions = {},
): CaptureOpenshellResult {
  const { gatewayName, ...spawnOpts } = opts;
  const sandboxGet = captureOpenshellCommand(
    binary,
    gatewayScopedArgs(["sandbox", "get", sandboxName], gatewayName),
    {
      ...spawnOpts,
      ignoreError: true,
      includeStderr: true,
    },
  );
  if (sandboxGet.status !== 0) {
    const output = sandboxGet.output || `failed to query sandbox '${sandboxName}'`;
    const sandboxMissing = /\bnot[- ]?found\b/i.test(output);
    return {
      ...sandboxGet,
      output: sandboxMissing ? `sandbox '${sandboxName}' not found` : output,
    };
  }
  // Pin every hop to the same gateway so `get` and `ssh-config` cannot
  // disagree about which one owns the sandbox.
  return captureOpenshellCommand(
    binary,
    gatewayScopedArgs(["sandbox", "ssh-config", sandboxName], gatewayName),
    spawnOpts,
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
  }).then((result) => ({
    status: result.status ?? (result.timedOut ? null : 1),
    output: `${result.stdout}${shouldIncludeStderr(opts) ? result.stderr : ""}`.trim(),
    ...maybeCapturedStreams(result.stdout, result.stderr, opts),
    ...(result.error ? { error: result.error } : {}),
    signal: result.signal,
  }));
}

/**
 * Own the asynchronous OpenShell child-process lifecycle shared by legacy
 * status capture and the typed buffered sandbox-command adapter.
 */
export function captureOpenshellCommandAsyncResult(
  binary: string,
  args: readonly string[],
  opts: OpenshellAsyncCaptureLifecycleOptions = {},
): Promise<OpenshellAsyncCaptureLifecycleResult> {
  const spawnImpl = opts.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const hasInput = opts.input !== undefined && opts.input.length > 0;
    let child: ChildProcess;
    try {
      child = spawnImpl(binary, [...args], {
        cwd: opts.cwd,
        env: opts.environment,
        detached: process.platform !== "win32",
        stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
      }) as ChildProcess;
    } catch (error) {
      resolve({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let interruptedBy: "SIGTERM" | "SIGINT" | null = null;
    let timeoutSignal: NodeJS.Signals | null = null;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let forceHandle: NodeJS.Timeout | undefined;
    let releaseSignals = () => {};
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const outputLimitBytes =
      opts.outputLimitBytes === undefined || opts.outputLimitBytes === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(opts.outputLimitBytes)
          ? Math.max(0, opts.outputLimitBytes)
          : 0;
    const killGraceMs = opts.killGraceMs ?? 1000;

    const clearTimers = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      if (forceHandle) clearTimeout(forceHandle);
    };
    const captured = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    });
    const settle = (result: OpenshellAsyncCaptureLifecycleResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      releaseSignals();
      resolve(result);
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const currentBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const chunks = stream === "stdout" ? stdoutChunks : stderrChunks;
      const available = Math.max(0, outputLimitBytes - currentBytes);
      if (available > 0) chunks.push(bytes.subarray(0, available));
      if (stream === "stdout") stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (bytes.length <= available) return;
      const error = Object.assign(new Error(`${stream} exceeded the buffered output limit`), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      signalProcessTree(child, "SIGKILL");
      settle({ status: null, signal: child.signalCode, ...captured(), error });
    };
    const interruptionError = (signal: "SIGTERM" | "SIGINT") =>
      Object.assign(new Error(`OpenShell command cancelled by ${signal}`), { code: "ECANCELED" });
    const beginInterruption = (signal: "SIGTERM" | "SIGINT") => {
      if (settled || timedOut || interruptedBy) return;
      interruptedBy = signal;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signalProcessTree(child, signal);
      killHandle = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        forceHandle = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle({
            status: null,
            signal: "SIGKILL",
            ...captured(),
            error: interruptionError(signal),
          });
        }, killGraceMs);
      }, killGraceMs);
    };

    if (opts.signalSource) {
      const forwardTerm = () => beginInterruption("SIGTERM");
      const forwardInt = () => beginInterruption("SIGINT");
      releaseSignals = () => {
        opts.signalSource?.remove("SIGTERM", forwardTerm);
        opts.signalSource?.remove("SIGINT", forwardInt);
      };
      opts.signalSource.add("SIGTERM", forwardTerm);
      opts.signalSource.add("SIGINT", forwardInt);
    }

    child.stdout?.on("data", (chunk: Buffer | string) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => capture("stderr", chunk));
    child.once("error", (error) => {
      if (timedOut) {
        signalProcessTree(child, "SIGKILL");
        settle({
          status: null,
          signal: child.signalCode ?? timeoutSignal,
          ...captured(),
          error: timeoutError(binary, [...args], opts.timeoutMilliseconds as number),
          timedOut: true,
          ...(timeoutSignal ? { timeoutSignal } : {}),
        });
        return;
      }
      if (interruptedBy) {
        signalProcessTree(child, "SIGKILL");
        settle({
          status: null,
          signal: child.signalCode ?? interruptedBy,
          ...captured(),
          error: interruptionError(interruptedBy),
        });
        return;
      }
      settle({ status: null, signal: child.signalCode, ...captured(), error });
    });
    child.once("close", (status, signal) => {
      if (timedOut) {
        signalProcessTree(child, "SIGKILL");
        settle({
          status,
          signal,
          ...captured(),
          error: timeoutError(binary, [...args], opts.timeoutMilliseconds as number),
          timedOut: true,
          ...(timeoutSignal ? { timeoutSignal } : {}),
        });
        return;
      }
      if (interruptedBy) {
        signalProcessTree(child, "SIGKILL");
        settle({
          status: null,
          signal: signal ?? interruptedBy,
          ...captured(),
          error: interruptionError(interruptedBy),
        });
        return;
      }
      settle({ status, signal, ...captured() });
    });
    if (hasInput) {
      child.stdin?.once("error", (error) => {
        if (settled) return;
        signalProcessTree(child, "SIGKILL");
        settle({ status: null, signal: child.signalCode, ...captured(), error });
      });
    }

    if (
      opts.timeoutMilliseconds !== undefined &&
      Number.isFinite(opts.timeoutMilliseconds) &&
      opts.timeoutMilliseconds > 0
    ) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutSignal = opts.timeoutKillSignal ?? "SIGTERM";
        child.unref();
        signalProcessTree(child, timeoutSignal);
        if (timeoutSignal === "SIGKILL") {
          forceHandle = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle({
              status: null,
              signal: "SIGKILL",
              ...captured(),
              error: timeoutError(binary, [...args], opts.timeoutMilliseconds as number),
              timedOut: true,
              timeoutSignal: "SIGKILL",
            });
          }, killGraceMs);
          return;
        }
        killHandle = setTimeout(() => {
          timeoutSignal = "SIGKILL";
          signalProcessTree(child, "SIGKILL");
          forceHandle = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle({
              status: null,
              signal: "SIGKILL",
              ...captured(),
              error: timeoutError(binary, [...args], opts.timeoutMilliseconds as number),
              timedOut: true,
              timeoutSignal: "SIGKILL",
            });
          }, killGraceMs);
        }, killGraceMs);
      }, opts.timeoutMilliseconds);
    }
    if (hasInput) child.stdin?.end(opts.input);
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
  return parseVersionFromText(versionResult.output, binary);
}
