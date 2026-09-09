// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createTempSshConfig } from "../../sandbox/temp-ssh-config";
import { resolveOpenshellSandboxSshHost } from "../openshell/sandbox-ssh-host";

export type SandboxCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

/**
 * Why a sandbox exec transport produced no usable result. A subprocess that is
 * killed by the outer timeout is a distinct condition from a subprocess that
 * failed to spawn or exited abnormally; callers such as the inference
 * invocation probe surface the real reason instead of a generic "unavailable"
 * message (#11162). The `detail` is limited to a subprocess error code so no
 * untrusted command output can leak through this boundary.
 */
export type SandboxCommandTransportFailure =
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "error"; detail?: string };

export type SandboxExecCommandOptions = {
  allowLocalDockerFallback?: boolean;
  gatewayName?: string;
  onTransportFailure?: (failure: SandboxCommandTransportFailure) => void;
  runtimeEnv?: NodeJS.ProcessEnv;
};

export type SandboxSshCommandOptions = {
  gatewayName?: string;
  runtimeEnv?: NodeJS.ProcessEnv;
};

export type CommandTransportDependencies = {
  buildSandboxExecMarkedCommand: (command: string) => string;
  buildSubprocessEnv: () => NodeJS.ProcessEnv;
  captureSandboxSshConfig: (
    sandboxName: string,
    options: {
      env?: NodeJS.ProcessEnv;
      gatewayName?: string;
      ignoreError: boolean;
      replaceEnv?: boolean;
      timeout: number;
    },
  ) => { output: string; status: number | null };
  executePrivilegedSandboxCommand: (
    sandboxName: string,
    command: readonly string[],
    options: { readonly sanitizeEnvironment: boolean; readonly timeout: number },
  ) => {
    readonly status: number | null;
    readonly stdout: string | Buffer;
    readonly stderr: string | Buffer;
    readonly error?: unknown;
  };
  extractSandboxExecCommandStdout: (output: string) => string | null;
  getOpenshellBinary: () => string;
  isDirectSandboxFallbackUnavailableError: (error: unknown) => boolean;
  openshellProbeTimeoutMs: number;
  root: string;
};

export const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15000;

function resolveSandboxExecTimeout(timeout: number): number {
  const timeoutOverride = Number(process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS || "");
  return Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : timeout;
}

/**
 * Classify a subprocess outcome that yielded no usable command result. A
 * subprocess timeout sets `error.code = "ETIMEDOUT"` and kills the child with
 * SIGTERM; report that as a timeout so callers can distinguish a slow endpoint
 * from a genuine subprocess error (#11162). A missing error and signal returns
 * `null`: the cause is unknown, so the caller keeps its generic message. Only
 * the error code (never the error message or any captured output) crosses this
 * boundary. Shared by the OpenShell exec transport and the DCode
 * `runOpenshell` probe path so both classify identically.
 */
export function classifySandboxCommandTransportFailure(
  outcome: { error?: unknown; signal?: NodeJS.Signals | null },
  timeoutMs: number,
): SandboxCommandTransportFailure | null {
  const error = outcome.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT" || outcome.signal === "SIGTERM") {
    return { kind: "timeout", timeoutMs };
  }
  if (error) {
    return error.code ? { kind: "error", detail: error.code } : { kind: "error" };
  }
  return null;
}

export function executeSandboxCommandTransport(
  deps: CommandTransportDependencies,
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  options: SandboxSshCommandOptions = {},
): SandboxCommandResult | null {
  const sshConfigResult = deps.captureSandboxSshConfig(sandboxName, {
    ...(options.runtimeEnv ? { env: options.runtimeEnv, replaceEnv: true } : {}),
    ...(options.gatewayName ? { gatewayName: options.gatewayName } : {}),
    ignoreError: true,
    timeout: deps.openshellProbeTimeoutMs,
  });
  if (sshConfigResult.status !== 0) return null;
  if (!sshConfigResult.output.trim()) return null;
  const sshHost = resolveOpenshellSandboxSshHost(sandboxName, sshConfigResult.output);
  if (sshHost === null) return null;

  const tmpSshConfig = createTempSshConfig(sshConfigResult.output, "nemoclaw-ssh-");
  try {
    const result = spawnSync(
      "ssh",
      [
        "-F",
        tmpSshConfig.file,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        sshHost,
        command,
      ],
      {
        encoding: "utf-8",
        env: options.runtimeEnv ?? deps.buildSubprocessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      },
    );
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  } finally {
    tmpSshConfig.cleanup();
  }
}

function parseSandboxCommandResult(
  deps: CommandTransportDependencies,
  result: {
    readonly status: number | null;
    readonly stdout: string | Buffer;
    readonly stderr: string | Buffer;
    readonly error?: unknown;
  },
): SandboxCommandResult | null {
  if (result.error) return null;
  const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout || "");
  const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr || "");
  const commandStdout = deps.extractSandboxExecCommandStdout(stdout);
  if (commandStdout === null) return null;
  return {
    status: result.status ?? 1,
    stdout: commandStdout,
    stderr: stderr.trim(),
  };
}

function executeLocalSandboxCommand(
  deps: CommandTransportDependencies,
  sandboxName: string,
  markedCommand: string,
  timeout: number,
): SandboxCommandResult | null {
  try {
    const result = deps.executePrivilegedSandboxCommand(sandboxName, ["sh", "-c", markedCommand], {
      sanitizeEnvironment: true,
      timeout,
    });
    return parseSandboxCommandResult(deps, result);
  } catch (error) {
    // Provider discovery failure or a stopped/nonexistent runtime resource means
    // there is no local fallback. Identity refusals, unsupported drivers,
    // registry corruption, and ambiguous matches are security-boundary
    // diagnostics: let callers surface them instead of collapsing them into an
    // inconclusive OpenShell transport result.
    if (deps.isDirectSandboxFallbackUnavailableError(error)) return null;
    throw error;
  }
}

export function executeSandboxExecCommandTransport(
  deps: CommandTransportDependencies,
  sandboxName: string,
  command: string,
  timeout: number,
  options: SandboxExecCommandOptions,
): SandboxCommandResult | null {
  const markedCommand = deps.buildSandboxExecMarkedCommand(command);
  const effectiveTimeout = resolveSandboxExecTimeout(timeout);
  let pendingFailure: SandboxCommandTransportFailure | null = null;
  try {
    const gatewayArgs = options.gatewayName ? ["-g", options.gatewayName] : [];
    const result = spawnSync(
      deps.getOpenshellBinary(),
      [
        "sandbox",
        "exec",
        "--name",
        sandboxName,
        ...gatewayArgs,
        "--",
        "sh",
        "-c",
        markedCommand,
      ],
      {
        cwd: deps.root,
        encoding: "utf-8",
        env: options.runtimeEnv ?? deps.buildSubprocessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: effectiveTimeout,
      },
    );
    const parsed = parseSandboxCommandResult(deps, result);
    if (parsed !== null) return parsed;
    pendingFailure = classifySandboxCommandTransportFailure(result, effectiveTimeout);
  } catch (error) {
    // OpenShell transport failed; try the trusted direct-container fallback.
    pendingFailure = classifySandboxCommandTransportFailure({ error }, effectiveTimeout);
  }
  if (options.allowLocalDockerFallback === false) {
    if (pendingFailure) options.onTransportFailure?.(pendingFailure);
    return null;
  }
  // Keep the fallback outside the OpenShell try/catch so a fail-closed identity
  // refusal cannot be caught and retried against changing container state.
  const fallback = executeLocalSandboxCommand(deps, sandboxName, markedCommand, effectiveTimeout);
  if (fallback === null && pendingFailure) options.onTransportFailure?.(pendingFailure);
  return fallback;
}
