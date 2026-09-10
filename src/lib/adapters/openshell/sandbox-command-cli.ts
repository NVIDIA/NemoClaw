// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";

import { spawnExitCode } from "../../core/process-exit";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { isValidName } from "../../sandbox-name-contract";
import { buildSubprocessEnv } from "../../subprocess-env";
import {
  captureOpenshellCommandAsyncResult,
  type OpenshellAsyncCaptureSignalSource,
} from "./client";
import { resolveOpenshellBinaryOrNull } from "./resolve-shared";
import {
  type OpenShellSandboxBufferedCommandCompletion,
  type OpenShellSandboxBufferedCommandRequest,
  type OpenShellSandboxBufferedCommandExecutor,
  type OpenShellSandboxCommandCompletion,
  type OpenShellSandboxCommandError,
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

export type OpenShellCommandSignalSource = OpenshellAsyncCaptureSignalSource;

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

export type OpenShellBufferedCommandRunResult = Readonly<{
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
}>;

export type OpenShellBufferedCommandRunner = (
  binary: string,
  args: readonly string[],
  options: Readonly<{
    environment?: NodeJS.ProcessEnv;
    hostCwd?: string;
    input?: string;
    outputLimitBytes?: number;
    signalSource?: OpenShellCommandSignalSource;
    timeoutMilliseconds?: number;
    timeoutKillSignal?: "SIGTERM" | "SIGKILL";
  }>,
) => Promise<OpenShellBufferedCommandRunResult>;

export type OpenShellCommandProbeRunner = (
  binary: string,
  args: readonly string[],
) => Pick<SpawnSyncReturns<string>, "error" | "status">;

export type CliOpenShellSandboxCommandExecutorDeps = Readonly<{
  resolveBinary?: () => string | null;
  spawnChild?: OpenShellCommandSpawner;
  spawnProbe?: OpenShellCommandProbeRunner;
  runBuffered?: OpenShellBufferedCommandRunner;
  signalSource?: OpenShellCommandSignalSource;
  hostCwd?: string;
  hostEnv?: NodeJS.ProcessEnv;
}>;

function targetArgs(target: OpenShellGatewayTarget): string[] {
  return target.kind === "named" ? ["-g", target.gatewayName] : [];
}

function assertTarget(target: OpenShellGatewayTarget, environment = process.env): void {
  if (target.kind === "named" && !isValidName(target.gatewayName)) {
    throw new Error("Invalid OpenShell gateway name");
  }
  assertNoOpenShellGatewayEndpointOverride(environment);
}

function assertSandboxName(sandboxName: string): void {
  if (!isValidName(sandboxName)) throw new Error("Invalid OpenShell sandbox name");
}

export function buildCliOpenShellSandboxExecArgs(
  request: OpenShellSandboxCommandRequest | OpenShellSandboxBufferedCommandRequest,
): string[] {
  const argv = ["sandbox", "exec", "--name", request.sandboxName, ...targetArgs(request.target)];
  if (request.workdir) argv.push("--workdir", request.workdir);
  if (request.tty === true) argv.push("--tty");
  if (request.tty === false) argv.push("--no-tty");
  if ("sandboxEnvironment" in request && request.sandboxEnvironment) {
    for (const [name, value] of Object.entries(request.sandboxEnvironment).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      argv.push("--env", `${name}=${value}`);
    }
  }
  if ("timeoutSeconds" in request && typeof request.timeoutSeconds === "number") {
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

const DEFAULT_BUFFERED_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export const runCliOpenShellBufferedCommand: OpenShellBufferedCommandRunner = async (
  binary,
  args,
  options,
) => {
  try {
    const result = await captureOpenshellCommandAsyncResult(binary, args, {
      cwd: options.hostCwd,
      environment: options.environment,
      // Ignored stdin supplies immediate EOF without opening a writable pipe
      // that can race a short-lived child with EPIPE.
      input: options.input,
      outputLimitBytes: options.outputLimitBytes ?? DEFAULT_BUFFERED_OUTPUT_LIMIT_BYTES,
      signalSource: options.signalSource ?? defaultSignalSource,
      timeoutKillSignal: options.timeoutKillSignal,
      timeoutMilliseconds: options.timeoutMilliseconds,
    });
    return {
      status: result.error ? null : result.status,
      signal: result.signal ?? result.timeoutSignal ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(!result.timedOut && result.error ? { error: result.error, timedOut: false } : {}),
    };
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
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

function commandError(error: Error): OpenShellSandboxCommandError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { kind: "unavailable", message: error.message };
  if (code === "ECANCELED") return { kind: "cancelled", message: error.message };
  if (code === "ETIMEDOUT") return { kind: "timeout", message: error.message };
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { kind: "capture", message: error.message };
  }
  return { kind: "invocation", message: error.message };
}

function commandFailure(error: Error): OpenShellSandboxCommandOutcome {
  return { kind: "failed", error: commandError(error) };
}

function bufferedCommandCompletion(
  result: OpenShellBufferedCommandRunResult,
): OpenShellSandboxBufferedCommandCompletion {
  let outcome: OpenShellSandboxCommandOutcome;
  if (result.timedOut) {
    outcome = {
      kind: "failed",
      error: { kind: "timeout", message: "OpenShell command timed out" },
    };
  } else if (result.error) {
    outcome = commandFailure(result.error);
  } else {
    outcome = {
      kind: "completed",
      exitCode: spawnExitCode(result),
      ...(result.signal ? { signal: result.signal } : {}),
    };
  }
  return { outcome, stdout: result.stdout, stderr: result.stderr };
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
): OpenShellSandboxCommandExecutor & OpenShellSandboxBufferedCommandExecutor {
  const resolveBinary = deps.resolveBinary ?? resolveOpenshellBinaryOrNull;
  const spawnProbe =
    deps.spawnProbe ??
    ((binary, args) => spawnSync(binary, [...args], { stdio: ["ignore", "ignore", "ignore"] }));
  const runBuffered = deps.runBuffered ?? runCliOpenShellBufferedCommand;
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
    runBuffered: async (request) => {
      assertSandboxName(request.sandboxName);
      const environment = request.environment ?? deps.hostEnv ?? buildSubprocessEnv();
      assertTarget(request.target, environment);
      const binary = resolveBinary();
      if (!binary) {
        return {
          outcome: {
            kind: "failed",
            error: { kind: "unavailable", message: "OpenShell binary not found" },
          },
          stdout: "",
          stderr: "",
        };
      }
      const result = await runBuffered(binary, buildCliOpenShellSandboxExecArgs(request), {
        environment,
        hostCwd: deps.hostCwd,
        input: request.input,
        outputLimitBytes: request.outputLimitBytes,
        ...(deps.signalSource ? { signalSource: deps.signalSource } : {}),
        timeoutMilliseconds: request.timeoutMilliseconds,
        ...(request.timeoutKillSignal ? { timeoutKillSignal: request.timeoutKillSignal } : {}),
      });
      return bufferedCommandCompletion(result);
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

export function createCurrentnessBoundCliOpenShellSandboxBufferedCommandExecutor(
  deps: CliOpenShellSandboxCommandExecutorDeps,
  assertCurrent: () => void,
): OpenShellSandboxBufferedCommandExecutor {
  const executor = createCliOpenShellSandboxCommandExecutor(deps);
  return {
    runBuffered: async (request) => {
      assertCurrent();
      try {
        return await executor.runBuffered(request);
      } finally {
        assertCurrent();
      }
    },
  };
}
