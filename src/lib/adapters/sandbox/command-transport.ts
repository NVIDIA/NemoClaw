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

export type SandboxExecCommandOptions = {
  allowLocalDockerFallback?: boolean;
  gatewayName?: string;
};

export type CommandTransportDependencies = {
  buildSandboxExecMarkedCommand: (command: string) => string;
  buildSubprocessEnv: () => NodeJS.ProcessEnv;
  captureSandboxSshConfig: (
    sandboxName: string,
    options: { ignoreError: boolean; timeout: number },
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
  withPrivilegedSandboxExecutionLease: <T>(
    sandboxName: string,
    operation: string,
    fn: () => T,
  ) => T;
};

export const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15000;

function resolveSandboxExecTimeout(timeout: number): number {
  const timeoutOverride = Number(process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS || "");
  return Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : timeout;
}

export function executeSandboxCommandTransport(
  deps: CommandTransportDependencies,
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
): SandboxCommandResult | null {
  return deps.withPrivilegedSandboxExecutionLease(
    sandboxName,
    "sandbox SSH command transport",
    () => {
      const sshConfigResult = deps.captureSandboxSshConfig(sandboxName, {
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
            env: deps.buildSubprocessEnv(),
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
    },
  );
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
  return deps.withPrivilegedSandboxExecutionLease(
    sandboxName,
    "sandbox OpenShell command transport",
    () => {
      const markedCommand = deps.buildSandboxExecMarkedCommand(command);
      const effectiveTimeout = resolveSandboxExecTimeout(timeout);
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
            env: deps.buildSubprocessEnv(),
            stdio: ["ignore", "pipe", "pipe"],
            timeout: effectiveTimeout,
          },
        );
        const parsed = parseSandboxCommandResult(deps, result);
        if (parsed !== null) return parsed;
      } catch {
        // OpenShell transport failed; try the trusted direct-container fallback.
      }
      if (options.allowLocalDockerFallback === false) return null;
      // Keep the fallback outside the OpenShell try/catch so a fail-closed identity
      // refusal cannot be caught and retried against changing container state.
      // The outer execution lease covers argv resolution and the complete fallback
      // subprocess lifetime without an unleased gap after the OpenShell attempt.
      return executeLocalSandboxCommand(deps, sandboxName, markedCommand, effectiveTimeout);
    },
  );
}
