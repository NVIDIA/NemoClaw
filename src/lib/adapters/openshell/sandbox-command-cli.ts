// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";

import { spawnExitCode } from "../../core/process-exit";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { isValidName } from "../../sandbox-name-contract";
import { resolveOpenshellBinaryOrNull } from "./resolve-shared";
import {
  type OpenShellSandboxCommandCompletion,
  type OpenShellSandboxCommandExecutor,
  type OpenShellSandboxCommandRequest,
  type OpenShellSandboxCommandOutcome,
} from "./sandbox-command";
import { buildSandboxCommandStdio } from "./sandbox-command-stdio";
import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellCommandChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal: NodeJS.Signals) => boolean;
  once: {
    (event: "error", listener: (error: Error) => void): unknown;
    (
      event: "close",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
  };
};

export type OpenShellCommandSpawner = (
  binary: string,
  args: readonly string[],
  options: OpenShellCommandChildOptions,
) => OpenShellCommandChild;

export type OpenShellCommandSignalSource = {
  add: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
  remove: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
};

export type OpenShellCommandChildOptions = Readonly<{
  stdin?: boolean;
  hostCwd?: string;
  hostEnv?: NodeJS.ProcessEnv;
}>;

export type OpenShellCommandSpawnResult = Readonly<{
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  releaseSignals?: () => void;
}>;

export type OpenShellCommandProbeRunner = (
  binary: string,
  args: readonly string[],
) => Pick<SpawnSyncReturns<string>, "error" | "status">;

export type CliOpenShellSandboxCommandExecutorDeps = Readonly<{
  resolveBinary?: () => string | null;
  spawnChild?: OpenShellCommandSpawner;
  spawnProbe?: OpenShellCommandProbeRunner;
  signalSource?: OpenShellCommandSignalSource;
  hostCwd?: string;
  hostEnv?: NodeJS.ProcessEnv;
}>;

function targetArgs(target: OpenShellGatewayTarget): string[] {
  return target.kind === "named" ? ["-g", target.gatewayName] : [];
}

function assertTarget(target: OpenShellGatewayTarget): void {
  if (target.kind === "named" && !isValidName(target.gatewayName)) {
    throw new Error("Invalid OpenShell gateway name");
  }
  assertNoOpenShellGatewayEndpointOverride();
}

function assertSandboxName(sandboxName: string): void {
  if (!isValidName(sandboxName)) throw new Error("Invalid OpenShell sandbox name");
}

export function buildCliOpenShellSandboxExecArgs(
  request: OpenShellSandboxCommandRequest,
): string[] {
  const argv = ["sandbox", "exec", "--name", request.sandboxName, ...targetArgs(request.target)];
  if (request.workdir) argv.push("--workdir", request.workdir);
  if (request.tty === true) argv.push("--tty");
  if (request.tty === false) argv.push("--no-tty");
  if (typeof request.timeoutSeconds === "number") {
    argv.push("--timeout", String(request.timeoutSeconds));
  }
  argv.push("--", ...request.command);
  return argv;
}

export function buildCliOpenShellSandboxDirectoryProbeArgs(request: {
  sandboxName: string;
  target: OpenShellGatewayTarget;
  path: string;
}): string[] {
  return [
    "sandbox",
    "exec",
    "--name",
    request.sandboxName,
    ...targetArgs(request.target),
    "--",
    "test",
    "-d",
    request.path,
  ];
}

const defaultSpawner: OpenShellCommandSpawner = (binary, args, options) =>
  spawn(binary, [...args], {
    stdio: buildSandboxCommandStdio(options),
    ...(options.hostCwd ? { cwd: options.hostCwd } : {}),
    ...(options.hostEnv ? { env: options.hostEnv } : {}),
  });

const defaultSignalSource: OpenShellCommandSignalSource = {
  add: (signal, listener) => process.on(signal, listener),
  remove: (signal, listener) => process.off(signal, listener),
};

export async function runCliOpenShellStreamingCommand(
  binary: string,
  args: readonly string[],
  options: OpenShellCommandChildOptions = {},
  spawnChild: OpenShellCommandSpawner = defaultSpawner,
  signalSource: OpenShellCommandSignalSource = defaultSignalSource,
): Promise<OpenShellCommandSpawnResult> {
  let child: OpenShellCommandChild;
  try {
    child = spawnChild(binary, args, options);
  } catch (error) {
    return { status: null, error: error instanceof Error ? error : new Error(String(error)) };
  }

  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    const forwardTerm = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    // A terminal Ctrl+C already reaches every member of the foreground process
    // group. Hold it in the parent without delivering it to the child twice.
    const holdInt = () => {};
    signalSource.add("SIGTERM", forwardTerm);
    signalSource.add("SIGINT", holdInt);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      resolve({
        status,
        signal,
        ...(spawnError ? { error: spawnError } : {}),
        releaseSignals: () => {
          signalSource.remove("SIGTERM", forwardTerm);
          signalSource.remove("SIGINT", holdInt);
        },
      });
    });
  });
}

function commandError(error: Error) {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    kind: code === "ENOENT" ? "unavailable" : code === "ETIMEDOUT" ? "timeout" : "invocation",
    message: error.message,
  } as const;
}

function commandFailure(error: Error): OpenShellSandboxCommandOutcome {
  return { kind: "failed", error: commandError(error) };
}

function commandCompletion(result: OpenShellCommandSpawnResult): OpenShellSandboxCommandCompletion {
  return {
    outcome: result.error
      ? commandFailure(result.error)
      : {
          kind: "completed",
          exitCode: spawnExitCode(result),
          ...(result.signal ? { signal: result.signal } : {}),
        },
    release: result.releaseSignals ?? (() => {}),
  };
}

function unavailableBinary(): OpenShellSandboxCommandCompletion {
  return {
    outcome: {
      kind: "failed",
      error: { kind: "unavailable", message: "OpenShell binary not found" },
    },
    release: () => {},
  };
}

export function createCliOpenShellSandboxCommandExecutor(
  deps: CliOpenShellSandboxCommandExecutorDeps = {},
): OpenShellSandboxCommandExecutor {
  const resolveBinary = deps.resolveBinary ?? resolveOpenshellBinaryOrNull;
  const spawnProbe =
    deps.spawnProbe ??
    ((binary, args) => spawnSync(binary, [...args], { stdio: ["ignore", "ignore", "ignore"] }));
  return {
    probeDirectory: async (request) => {
      assertSandboxName(request.sandboxName);
      assertTarget(request.target);
      const binary = resolveBinary();
      if (!binary) {
        return {
          state: "unobservable",
          error: { kind: "unavailable", message: "OpenShell binary not found" },
        };
      }
      let result: Pick<SpawnSyncReturns<string>, "error" | "status">;
      try {
        result = spawnProbe(binary, buildCliOpenShellSandboxDirectoryProbeArgs(request));
      } catch (error) {
        const invocation = error instanceof Error ? error : new Error(String(error));
        return {
          state: "unobservable",
          error: commandError(invocation),
        };
      }
      if (result.error || result.status === null) {
        return {
          state: "unobservable",
          ...(result.error ? { error: commandError(result.error) } : {}),
        };
      }
      if (result.status === 0) return { state: "present" };
      return result.status === 1 ? { state: "missing" } : { state: "unobservable" };
    },
    runStreaming: async (request) => {
      assertSandboxName(request.sandboxName);
      assertTarget(request.target);
      const binary = resolveBinary();
      if (!binary) return unavailableBinary();
      const result = await runCliOpenShellStreamingCommand(
        binary,
        buildCliOpenShellSandboxExecArgs(request),
        {
          stdin: request.stdin,
          hostCwd: deps.hostCwd,
          hostEnv: deps.hostEnv,
        },
        deps.spawnChild,
        deps.signalSource,
      );
      return commandCompletion(result);
    },
  };
}
