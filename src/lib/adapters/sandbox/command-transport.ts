// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxBufferedCommandExecutor } from "../openshell/sandbox-command";
import { namedOpenShellGateway, selectedOpenShellGateway } from "../openshell/sandbox-observer";
import { createCliOpenShellSandboxSshCommandExecutor } from "../openshell/sandbox-ssh-cli";
import type { OpenShellSandboxSshExecutor } from "../openshell/sandbox-ssh";

export type SandboxCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

/**
 * Declares when a command is safe to repeat through the pinned local runtime.
 * `read-only` commands cannot leave a mutation to reconcile. `reconciled`
 * commands are idempotent and verify their postcondition before continuing.
 */
export type LocalDockerFallbackPolicy = "never" | "unavailable-only" | "read-only" | "reconciled";

export type SandboxExecCommandOptions = {
  localDockerFallbackPolicy?: LocalDockerFallbackPolicy;
  gatewayName?: string;
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
  } else if (
    completed.outcome.error.kind !== "unavailable" &&
    !permitsUnknownOutcomeFallback(fallbackPolicy)
  ) {
    return null;
  }
  if (fallbackPolicy === "never") return null;
  // Keep the fallback outside the OpenShell try/catch so a fail-closed identity
  // refusal cannot be caught and retried against changing container state.
  return executeLocalSandboxCommand(deps, sandboxName, markedCommand, effectiveTimeout);
}
