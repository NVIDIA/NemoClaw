// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";

import { spawnExitCode } from "../../core/process-exit";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { isValidName } from "../../sandbox-name-contract";
import { buildSubprocessEnv } from "../../subprocess-env";
import { resolveOpenshellBinaryOrNull } from "./resolve-shared";
import {
  type OpenShellSandboxBufferedCommandCompletion,
  type OpenShellSandboxBufferedCommandRequest,
  type OpenShellSandboxBufferedCommandExecutor,
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
const DEFAULT_BUFFERED_KILL_GRACE_MS = 1_000;

function signalBufferedProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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
      // The process may have exited between the deadline and signal delivery.
    }
  }
}

export const runCliOpenShellBufferedCommand: OpenShellBufferedCommandRunner = (
  binary,
  args,
  options,
) =>
  new Promise((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let timeoutSignal: NodeJS.Signals | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_BUFFERED_OUTPUT_LIMIT_BYTES;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let killHandle: ReturnType<typeof setTimeout> | undefined;
    let forceHandle: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      if (forceHandle) clearTimeout(forceHandle);
    };
    const settle = (result: OpenShellBufferedCommandRunResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const captured = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    });
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
      signalBufferedProcessTree(child, "SIGKILL");
      settle({ status: null, ...captured(), error });
    };
    try {
      child = spawn(binary, [...args], {
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.hostCwd ? { cwd: options.hostCwd } : {}),
        ...(options.environment ? { env: options.environment } : {}),
      });
    } catch (error) {
      settle({
        status: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => capture("stderr", chunk));
    child.once("error", (error) => {
      settle({ status: null, signal: child.signalCode, ...captured(), error, timedOut });
    });
    child.once("close", (status, signal) => {
      if (timedOut) {
        const completionSignal = signal ?? timeoutSignal;
        signalBufferedProcessTree(child, "SIGKILL");
        settle({
          status: null,
          signal: completionSignal,
          ...captured(),
          timedOut: true,
        });
        return;
      }
      settle({ status, signal, ...captured() });
    });
    child.stdin?.once("error", (error) => {
      signalBufferedProcessTree(child, "SIGKILL");
      settle({ status: null, signal: child.signalCode, ...captured(), error, timedOut });
    });
    if (
      options.timeoutMilliseconds !== undefined &&
      Number.isFinite(options.timeoutMilliseconds) &&
      options.timeoutMilliseconds > 0
    ) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutSignal = options.timeoutKillSignal ?? "SIGTERM";
        signalBufferedProcessTree(child, timeoutSignal);
        if (timeoutSignal === "SIGKILL") {
          forceHandle = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle({ status: null, signal: "SIGKILL", ...captured(), timedOut: true });
          }, DEFAULT_BUFFERED_KILL_GRACE_MS);
          return;
        }
        killHandle = setTimeout(() => {
          timeoutSignal = "SIGKILL";
          signalBufferedProcessTree(child, "SIGKILL");
          forceHandle = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle({ status: null, signal: "SIGKILL", ...captured(), timedOut: true });
          }, DEFAULT_BUFFERED_KILL_GRACE_MS);
        }, DEFAULT_BUFFERED_KILL_GRACE_MS);
      }, options.timeoutMilliseconds);
    }
    child.stdin?.end(options.input);
  });

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
    kind:
      code === "ENOENT"
        ? "unavailable"
        : code === "ETIMEDOUT"
          ? "timeout"
          : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "capture"
            : "invocation",
    message: error.message,
  } as const;
}

function commandFailure(error: Error): OpenShellSandboxCommandOutcome {
  return { kind: "failed", error: commandError(error) };
}

function bufferedCommandCompletion(
  result: OpenShellBufferedCommandRunResult,
): OpenShellSandboxBufferedCommandCompletion {
  const outcome = result.timedOut
    ? {
        kind: "failed" as const,
        error: { kind: "timeout" as const, message: "OpenShell command timed out" },
      }
    : result.error
      ? commandFailure(result.error)
      : {
          kind: "completed" as const,
          exitCode: spawnExitCode(result),
          ...(result.signal ? { signal: result.signal } : {}),
        };
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
