// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { resolveOpenshellSandboxSshHost } from "../openshell/sandbox-ssh-host";
import { captureSandboxSshConfigCommand } from "../openshell/command-execution";
import { resolveOpenshellBinaryOrNull } from "../openshell/resolve-shared";
import { createTempSshConfig, runWithTempSshConfigCleanup } from "../../sandbox/temp-ssh-config";
import type {
  OpenShellSandboxBufferedCommandExecutor,
  OpenShellSandboxCommandError,
} from "../openshell/sandbox-command";
import { namedOpenShellGateway, selectedOpenShellGateway } from "../openshell/sandbox-observer";

import {
  buildSandboxCommandEnvironment,
  createCliOpenShellSandboxCommandExecutor,
} from "../openshell/sandbox-command-cli";
export { buildSandboxCommandEnvironment } from "../openshell/sandbox-command-cli";
import type { OpenShellRuntimeSelection } from "../openshell/runtime-selection";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { parseTimerDelayMs } from "../../core/timer";
import {
  buildSandboxExecMarkedCommand,
  extractSandboxExecCommandStdout,
} from "./sandbox-exec-output";

export type SandboxCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type SandboxExecCommandOptions = {
  /** Internal bounded probes must retain their caller deadline despite ambient overrides. */
  honorCallerTimeout?: boolean;
  gatewayName?: string;
  runtimeEnv?: NodeJS.ProcessEnv;
};

export type CommandTransportDependencies = {
  buildSandboxExecMarkedCommand: (command: string) => string;
  buildSubprocessEnv: () => NodeJS.ProcessEnv;
  extractSandboxExecCommandStdout: (output: string) => string | null;
  commandExecutor: OpenShellSandboxBufferedCommandExecutor;
};

export const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15000;

/** A transport failure must not be interpreted as a remote exit or authorize a retry. */
export class SandboxCommandTransportError extends Error {
  constructor(readonly kind: OpenShellSandboxCommandError["kind"] | "malformed") {
    super(`Sandbox command transport failed (${kind}); the command was not retried.`);
    this.name = "SandboxCommandTransportError";
  }
}

export async function executeSandboxExecCommandTransport(
  deps: CommandTransportDependencies,
  sandboxName: string,
  command: string,
  timeout: number,
  options: SandboxExecCommandOptions,
): Promise<SandboxCommandResult> {
  const timeoutOverride = parseTimerDelayMs(process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS);
  const completed = await deps.commandExecutor.runBuffered({
    sandboxName,
    target: options.gatewayName
      ? namedOpenShellGateway(options.gatewayName)
      : selectedOpenShellGateway(),
    command: ["sh", "-c", deps.buildSandboxExecMarkedCommand(command)],
    environment: options.runtimeEnv ?? deps.buildSubprocessEnv(),
    timeoutMilliseconds:
      !options.honorCallerTimeout && timeoutOverride !== undefined ? timeoutOverride : timeout,
  });
  if (completed.outcome.kind === "failed") {
    throw new SandboxCommandTransportError(completed.outcome.error.kind);
  }
  const stdout = deps.extractSandboxExecCommandStdout(completed.stdout);
  if (stdout === null) throw new SandboxCommandTransportError("malformed");
  return { status: completed.outcome.exitCode, stdout, stderr: completed.stderr.trim() };
}

export type SandboxExecCommandExecutionOptions = SandboxExecCommandOptions & {
  commandExecutor?: OpenShellSandboxBufferedCommandExecutor;
  runtimeSelection?: OpenShellRuntimeSelection;
};

/** Ordinary probes must not evaluate runtime-owned or sandbox-user-owned shell state. */
export function wrapOrdinarySandboxCommand(command: readonly string[]): string[] {
  return [
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-p",
    "-c",
    'builtin unset OPENCLAW_GATEWAY_TOKEN; builtin exec -- "$@"',
    "nemoclaw-runtime-env",
    ...command,
  ];
}

function commandTransportDependencies(
  commandExecutor: OpenShellSandboxBufferedCommandExecutor = createCliOpenShellSandboxCommandExecutor(
    { hostCwd: REPOSITORY_ROOT },
  ),
): CommandTransportDependencies {
  return {
    buildSandboxExecMarkedCommand,
    buildSubprocessEnv: buildSandboxCommandEnvironment,
    extractSandboxExecCommandStdout,
    commandExecutor: {
      runBuffered: (request) =>
        commandExecutor.runBuffered({
          ...request,
          command: wrapOrdinarySandboxCommand(request.command),
        }),
    },
  };
}

export async function executeSandboxExecCommand(
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  options: SandboxExecCommandExecutionOptions = {},
): Promise<SandboxCommandResult> {
  const { runtimeSelection, commandExecutor, ...transportOptions } = options;
  const runtimeEnv = buildSandboxCommandEnvironment(runtimeSelection, options.runtimeEnv);
  return executeSandboxExecCommandTransport(
    commandTransportDependencies(commandExecutor),
    sandboxName,
    command,
    timeout,
    {
      ...transportOptions,
      ...(runtimeSelection
        ? {
            gatewayName: runtimeSelection.gatewayName,
          }
        : {}),
      ...(runtimeEnv ? { runtimeEnv } : {}),
    },
  );
}

// Maintenance deliberately holds the gateway down. OpenShell exec requires
// Ready, while its SSH transport remains available to the sandbox owner.
export async function executeSandboxMaintenanceCommand(
  sandboxName: string,
  command: string,
  timeout: number,
  options: SandboxExecCommandExecutionOptions = {},
): Promise<SandboxCommandResult | null> {
  const deadline = Date.now() + timeout;
  const binary = resolveOpenshellBinaryOrNull();
  if (!binary) return null;
  const environment = buildSandboxCommandEnvironment(options.runtimeSelection, options.runtimeEnv);
  const config = captureSandboxSshConfigCommand(binary, sandboxName, {
    env: environment,
    replaceEnv: true,
    gatewayName: options.runtimeSelection?.gatewayName,
    ignoreError: true,
    timeout: Math.max(1, Math.floor(timeout / 3)),
  });
  if (config.status !== 0 || config.error) return null;
  const host = resolveOpenshellSandboxSshHost(sandboxName, config.output);
  if (!host) return null;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const temporary = createTempSshConfig(config.output, "nemoclaw-openclaw-maintenance-");
  const completed = runWithTempSshConfigCleanup(temporary, () => {
    const result = spawnSync(
      "ssh",
      [
        "-F",
        temporary.file,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "LogLevel=ERROR",
        host,
        "/bin/bash --noprofile --norc -p -s",
      ],
      {
        encoding: "utf8",
        input: `builtin unset OPENCLAW_GATEWAY_TOKEN\n${command}`,
        env: environment,
        timeout: remaining,
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        killSignal: "SIGKILL",
      },
    );
    if (result.error || result.signal || result.status === null || result.status === 255)
      return null;
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  });
  if (completed.cleanupError) throw completed.cleanupError;
  return completed.result;
}
