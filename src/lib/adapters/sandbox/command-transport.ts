// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellSandboxBufferedCommandExecutor,
  OpenShellSandboxCommandError,
} from "../openshell/sandbox-command";
import { namedOpenShellGateway, selectedOpenShellGateway } from "../openshell/sandbox-observer";

import { createCliOpenShellSandboxCommandExecutor } from "../openshell/sandbox-command-cli";
import {
  buildOpenShellRuntimeSelectionEnv,
  type OpenShellRuntimeSelection,
} from "../openshell/runtime-selection";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { buildSubprocessEnv } from "../../subprocess-env";
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
  const timeoutOverride = Number(process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS || "");
  const completed = await deps.commandExecutor.runBuffered({
    sandboxName,
    target: options.gatewayName
      ? namedOpenShellGateway(options.gatewayName)
      : selectedOpenShellGateway(),
    command: ["sh", "-c", deps.buildSandboxExecMarkedCommand(command)],
    environment: options.runtimeEnv ?? deps.buildSubprocessEnv(),
    timeoutMilliseconds:
      !options.honorCallerTimeout && Number.isFinite(timeoutOverride) && timeoutOverride > 0
        ? timeoutOverride
        : timeout,
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
    buildSubprocessEnv,
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

/** Apply the same filtered environment and recorded runtime to native sandbox probes. */
export function buildSandboxCommandEnvironment(
  runtimeSelection?: OpenShellRuntimeSelection,
  runtimeEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return runtimeSelection
    ? buildOpenShellRuntimeSelectionEnv(buildSubprocessEnv(), runtimeSelection)
    : (runtimeEnv ?? buildSubprocessEnv());
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
