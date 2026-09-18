// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellSandboxBufferedCommandExecutor,
  OpenShellSandboxCommandError,
} from "../openshell/sandbox-command";
import { namedOpenShellGateway, selectedOpenShellGateway } from "../openshell/sandbox-observer";
import { createCliOpenShellSandboxSshCommandExecutor } from "../openshell/sandbox-ssh-cli";
import type { OpenShellSandboxSshExecutor } from "../openshell/sandbox-ssh";

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

/**
 * Declares when a command is safe to repeat through the pinned local runtime.
 * `read-only` commands cannot leave a mutation to reconcile. `reconciled`
 * commands are idempotent and verify their postcondition before continuing.
 */
export type LocalDockerFallbackPolicy = "never" | "unavailable-only" | "read-only" | "reconciled";

export type SandboxExecCommandOptions = {
  localDockerFallbackPolicy?: LocalDockerFallbackPolicy;
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
  sshExecutor?: OpenShellSandboxSshExecutor;
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
  commandExecutor: OpenShellSandboxBufferedCommandExecutor;
  isDirectSandboxFallbackUnavailableError: (error: unknown) => boolean;
};

export const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15000;

function resolveSandboxExecTimeout(timeout: number): number {
  const timeoutOverride = Number(process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS || "");
  return Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : timeout;
}

/**
 * Classify a typed OpenShell command failure that yielded no usable result so
 * callers can distinguish a slow endpoint (a timeout) from a genuine subprocess
 * error (#11162). A `timeout` outcome reports the effective duration; every
 * other transport failure kind reports its kind as the error detail. Only the
 * error kind (never the error message or any captured output) crosses this
 * boundary. An `unavailable` outcome is not a probe-transport failure — it means
 * OpenShell itself was absent, so the caller keeps its generic message.
 */
export function classifyOutcomeTransportFailure(
  error: OpenShellSandboxCommandError,
  timeoutMs: number,
): SandboxCommandTransportFailure | null {
  if (error.kind === "timeout") return { kind: "timeout", timeoutMs };
  if (error.kind === "unavailable") return null;
  return { kind: "error", detail: error.kind };
}

function permitsUnknownOutcomeFallback(policy: LocalDockerFallbackPolicy): boolean {
  return policy === "read-only" || policy === "reconciled";
}

export async function executeSandboxCommandTransport(
  deps: CommandTransportDependencies,
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  options: SandboxSshCommandOptions = {},
): Promise<SandboxCommandResult | null> {
  const result = await (deps.sshExecutor ?? createCliOpenShellSandboxSshCommandExecutor()).run({
    sandboxName,
    target: options.gatewayName
      ? namedOpenShellGateway(options.gatewayName)
      : selectedOpenShellGateway(),
    command,
    environment: options.runtimeEnv ?? deps.buildSubprocessEnv(),
    timeoutMilliseconds: timeout,
  });
  const commandResult = result.kind === "completed" ? result : result.command;
  return commandResult
    ? {
        status: commandResult.exitCode,
        stdout: commandResult.stdout.trim(),
        stderr: commandResult.stderr.trim(),
      }
    : null;
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

export async function executeSandboxExecCommandTransport(
  deps: CommandTransportDependencies,
  sandboxName: string,
  command: string,
  timeout: number,
  options: SandboxExecCommandOptions,
): Promise<SandboxCommandResult | null> {
  const markedCommand = deps.buildSandboxExecMarkedCommand(command);
  const effectiveTimeout = resolveSandboxExecTimeout(timeout);
  const fallbackPolicy = options.localDockerFallbackPolicy ?? "unavailable-only";
  // Track why the OpenShell transport produced no usable result so a caller
  // that opted out of the local fallback can surface the real reason instead of
  // a generic "unavailable" message (#11162). Only a subprocess error code or a
  // timeout duration crosses this boundary — never captured command output.
  let pendingFailure: SandboxCommandTransportFailure | null = null;
  const completed = await deps.commandExecutor.runBuffered({
    sandboxName,
    target: options.gatewayName
      ? namedOpenShellGateway(options.gatewayName)
      : selectedOpenShellGateway(),
    command: ["sh", "-c", markedCommand],
    environment: options.runtimeEnv ?? deps.buildSubprocessEnv(),
    timeoutMilliseconds: effectiveTimeout,
  });
  if (completed.outcome.kind === "completed") {
    const parsed = parseSandboxCommandResult(deps, {
      status: completed.outcome.exitCode,
      stdout: completed.stdout,
      stderr: completed.stderr,
    });
    if (parsed !== null) return parsed;
    if (!permitsUnknownOutcomeFallback(fallbackPolicy)) return null;
  } else if (completed.outcome.error.kind === "cancelled") {
    return null;
  } else {
    pendingFailure = classifyOutcomeTransportFailure(completed.outcome.error, effectiveTimeout);
    if (
      completed.outcome.error.kind !== "unavailable" &&
      !permitsUnknownOutcomeFallback(fallbackPolicy)
    ) {
      if (pendingFailure) options.onTransportFailure?.(pendingFailure);
      return null;
    }
  }
  if (fallbackPolicy === "never") {
    if (pendingFailure) options.onTransportFailure?.(pendingFailure);
    return null;
  }
  // Keep the fallback outside the OpenShell outcome handling so a fail-closed
  // identity refusal cannot be retried against changing container state.
  const fallback = executeLocalSandboxCommand(deps, sandboxName, markedCommand, effectiveTimeout);
  if (fallback === null && pendingFailure) options.onTransportFailure?.(pendingFailure);
  return fallback;
}
