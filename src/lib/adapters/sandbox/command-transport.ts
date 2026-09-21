// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellSandboxBufferedCommandExecutor,
  OpenShellSandboxCommandError,
} from "../openshell/sandbox-command";
import { namedOpenShellGateway, selectedOpenShellGateway } from "../openshell/sandbox-observer";

export type SandboxCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type SandboxExecCommandOptions = {
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
      Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : timeout,
  });
  if (completed.outcome.kind === "failed") {
    throw new SandboxCommandTransportError(completed.outcome.error.kind);
  }
  const stdout = deps.extractSandboxExecCommandStdout(completed.stdout);
  if (stdout === null) throw new SandboxCommandTransportError("malformed");
  return { status: completed.outcome.exitCode, stdout, stderr: completed.stderr.trim() };
}
