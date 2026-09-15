// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";

import { spawnExitCode } from "../../core/process-exit";
import { ROOT } from "../../runner";
import { redactCredentialText } from "../../security/credential-filter";
import {
  assertCliOpenShellSandboxName,
  assertCliOpenShellTarget,
  runCliOpenShellBufferedCommand,
} from "./sandbox-command-cli";
import type { OpenShellBufferedCommandRunner } from "./sandbox-command-cli";
import { resolveOpenshellBinaryOrNull } from "./resolve-shared";
import { buildOpenShellSubprocessEnv } from "./runtime";
import type {
  OpenShellSandboxLogError,
  OpenShellSandboxLogFollowSession,
  OpenShellSandboxLogOutcome,
  OpenShellSandboxLogOutput,
  OpenShellSandboxLogRequest,
  OpenShellSandboxLogs,
} from "./sandbox-logs";

const LOG_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const LOG_DIAGNOSTIC_LINE_LIMIT_CHARS = 64 * 1024;

type LogChildOutput = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  pause(): void;
  resume(): void;
  destroy(): void;
  setEncoding(encoding: BufferEncoding): void;
};

export type OpenShellLogChild = {
  stderr: LogChildOutput | null;
  stdout: LogChildOutput | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

export type OpenShellLogSpawner = (
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: StdioOptions },
) => OpenShellLogChild;

export type CliOpenShellSandboxLogsDeps = Readonly<{
  resolveBinary?: () => string | null;
  runBuffered?: OpenShellBufferedCommandRunner;
  spawnChild?: OpenShellLogSpawner;
  environment?: NodeJS.ProcessEnv;
  hostCwd?: string;
  outputLimitBytes?: number;
  timeoutMilliseconds?: number;
}>;

function targetArgs(request: OpenShellSandboxLogRequest): string[] {
  return request.target.kind === "named" ? ["-g", request.target.gatewayName] : [];
}

export function buildCliOpenShellSandboxLogArgs(
  request: OpenShellSandboxLogRequest,
  follow: boolean,
): string[] {
  if (request.source === "gateway") {
    const args = [
      "sandbox",
      "exec",
      ...targetArgs(request),
      "-n",
      request.sandboxName,
      "--",
      "tail",
      "-n",
      request.lines,
    ];
    if (follow) args.push("-f");
    args.push("/tmp/gateway.log");
    return args;
  }
  const args = [
    "logs",
    ...targetArgs(request),
    request.sandboxName,
    "-n",
    request.lines,
    "--source",
    "all",
  ];
  if (request.since) args.push("--since", request.since);
  if (follow) args.push("--tail");
  return args;
}

function validateRequest(
  request: OpenShellSandboxLogRequest,
  environment: NodeJS.ProcessEnv,
): void {
  if (
    !/^\d+$/u.test(request.lines) ||
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    /[\0\r\n]/u.test(request.since ?? "") ||
    (request.source === "gateway" && request.since !== null)
  ) {
    throw new Error("Invalid OpenShell sandbox log request");
  }
  assertCliOpenShellSandboxName(request.sandboxName);
  assertCliOpenShellTarget(request.target, environment);
}

function failed(error: OpenShellSandboxLogError, exitCode = 1): OpenShellSandboxLogOutcome {
  return { kind: "failed", error, exitCode };
}

function terminationReason(
  signal: NodeJS.Signals | null | undefined,
): Extract<OpenShellSandboxLogOutcome, { kind: "completed" }>["termination"] {
  if (signal === "SIGPIPE") return "broken_pipe";
  if (signal === "SIGHUP") return "hangup";
  if (signal === "SIGINT") return "interrupted";
  if (signal === "SIGTERM") return "terminated";
  return signal ? "other_signal" : undefined;
}

function classifyError(error: Error): OpenShellSandboxLogError {
  const code = (error as NodeJS.ErrnoException).code;
  const message = redactCredentialText(error.message);
  if (code === "ENOENT") return { kind: "unavailable", message };
  if (code === "ETIMEDOUT") return { kind: "timeout", message };
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { kind: "capture", message };
  }
  return { kind: "invocation", message };
}

function buildLogEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = buildOpenShellSubprocessEnv(source);
  for (const name of [
    "OPENSHELL_GATEWAY",
    "OPENSHELL_WORKSPACE",
    "OPENSHELL_LOCAL_TLS_DIR",
  ] as const) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function outputView(output: LogChildOutput): OpenShellSandboxLogOutput {
  output.setEncoding("utf8");
  return {
    onChunk(listener) {
      output.on("data", (chunk) => listener(String(chunk)));
    },
    onEnd(listener) {
      output.on("end", listener);
    },
    onError(listener) {
      output.on("error", listener);
    },
    pause: () => output.pause(),
    resume: () => output.resume(),
    close: () => output.destroy(),
  };
}

function redactedDiagnosticOutputView(output: LogChildOutput): OpenShellSandboxLogOutput {
  output.setEncoding("utf8");
  return {
    onChunk(listener) {
      let pending = "";
      let discardingOversizedLine = false;
      output.on("data", (chunk) => {
        let remaining = String(chunk);
        while (remaining) {
          const newlineIndex = remaining.indexOf("\n");
          const segment = newlineIndex === -1 ? remaining : remaining.slice(0, newlineIndex + 1);
          remaining = newlineIndex === -1 ? "" : remaining.slice(newlineIndex + 1);

          if (discardingOversizedLine) {
            if (newlineIndex !== -1) discardingOversizedLine = false;
            continue;
          }

          pending += segment;
          if (pending.length > LOG_DIAGNOSTIC_LINE_LIMIT_CHARS) {
            listener("OpenShell diagnostic omitted: line exceeded safe display limit.\n");
            pending = "";
            discardingOversizedLine = newlineIndex === -1;
            continue;
          }
          if (newlineIndex !== -1) {
            listener(redactCredentialText(pending));
            pending = "";
          }
        }
      });
      output.on("end", () => {
        if (pending) listener(redactCredentialText(pending));
      });
    },
    onEnd(listener) {
      output.on("end", listener);
    },
    onError(listener) {
      output.on("error", listener);
    },
    pause: () => output.pause(),
    resume: () => output.resume(),
    close: () => output.destroy(),
  };
}

function immediateFailure(error: OpenShellSandboxLogError): OpenShellSandboxLogFollowSession {
  return {
    diagnostic: null,
    output: null,
    cancel() {},
    completion: Promise.resolve({ outcome: failed(error) }),
  };
}

export function createCliOpenShellSandboxLogs(
  deps: CliOpenShellSandboxLogsDeps = {},
): OpenShellSandboxLogs {
  const resolveBinary = deps.resolveBinary ?? resolveOpenshellBinaryOrNull;
  const runBuffered = deps.runBuffered ?? runCliOpenShellBufferedCommand;
  const hostCwd = deps.hostCwd ?? ROOT;
  return {
    checkAvailability() {
      try {
        return resolveBinary()
          ? null
          : { kind: "unavailable", message: "OpenShell binary not found" };
      } catch (error) {
        return classifyError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    async read(request) {
      const sourceEnvironment = deps.environment ?? process.env;
      try {
        validateRequest(request, sourceEnvironment);
      } catch (error) {
        return {
          content: "",
          diagnostic: "",
          outcome: failed({
            kind: "configuration",
            message: error instanceof Error ? error.message : String(error),
          }),
        };
      }
      const environment = buildLogEnvironment(sourceEnvironment);
      let binary: string | null;
      try {
        binary = resolveBinary();
      } catch (error) {
        return {
          content: "",
          diagnostic: "",
          outcome: failed(classifyError(error instanceof Error ? error : new Error(String(error)))),
        };
      }
      if (!binary) {
        return {
          content: "",
          diagnostic: "",
          outcome: failed({ kind: "unavailable", message: "OpenShell binary not found" }),
        };
      }
      let result: Awaited<ReturnType<OpenShellBufferedCommandRunner>>;
      try {
        result = await runBuffered(binary, buildCliOpenShellSandboxLogArgs(request, false), {
          environment,
          hostCwd,
          outputLimitBytes: deps.outputLimitBytes ?? LOG_OUTPUT_LIMIT_BYTES,
          timeoutKillSignal: "SIGKILL",
          timeoutMilliseconds: deps.timeoutMilliseconds ?? request.timeoutMs,
        });
      } catch (error) {
        return {
          content: "",
          diagnostic: "",
          outcome: failed(classifyError(error instanceof Error ? error : new Error(String(error)))),
        };
      }
      if (result.error) {
        return {
          content: result.stdout,
          diagnostic: redactCredentialText(result.stderr),
          outcome: failed(classifyError(result.error)),
        };
      }
      if (result.timedOut) {
        return {
          content: result.stdout,
          diagnostic: redactCredentialText(result.stderr),
          outcome: failed({
            kind: "timeout",
            message: "OpenShell log read timed out (ETIMEDOUT)",
          }),
        };
      }
      return {
        content: result.stdout,
        diagnostic: redactCredentialText(result.stderr),
        outcome: {
          kind: "completed",
          exitCode: spawnExitCode(result),
          ...(terminationReason(result.signal)
            ? { termination: terminationReason(result.signal) }
            : {}),
        },
      };
    },
    follow(request) {
      const sourceEnvironment = deps.environment ?? process.env;
      try {
        validateRequest(request, sourceEnvironment);
      } catch (error) {
        return immediateFailure({
          kind: "configuration",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      let binary: string | null;
      try {
        binary = resolveBinary();
      } catch (error) {
        return immediateFailure(
          classifyError(error instanceof Error ? error : new Error(String(error))),
        );
      }
      if (!binary) {
        return immediateFailure({ kind: "unavailable", message: "OpenShell binary not found" });
      }
      const environment = buildLogEnvironment(sourceEnvironment);
      const spawnChild: OpenShellLogSpawner =
        deps.spawnChild ??
        ((file, args, options) => spawn(file, [...args], options) as OpenShellLogChild);
      let child: OpenShellLogChild;
      try {
        child = spawnChild(binary, buildCliOpenShellSandboxLogArgs(request, true), {
          cwd: hostCwd,
          env: environment,
          stdio:
            request.source === "gateway"
              ? ["inherit", "pipe", "pipe"]
              : ["inherit", "inherit", "pipe"],
        });
      } catch (error) {
        return immediateFailure(
          classifyError(error instanceof Error ? error : new Error(String(error))),
        );
      }
      const completion = new Promise<{ outcome: OpenShellSandboxLogOutcome }>((resolve) => {
        child.on("error", (error) => {
          resolve({ outcome: failed(classifyError(error)) });
        });
        child.on("exit", (code, signal) => {
          resolve({
            outcome: {
              kind: "completed",
              exitCode: spawnExitCode({ status: code, signal }),
              ...(terminationReason(signal) ? { termination: terminationReason(signal) } : {}),
            },
          });
        });
      });
      return {
        diagnostic: child.stderr ? redactedDiagnosticOutputView(child.stderr) : null,
        output: child.stdout ? outputView(child.stdout) : null,
        completion,
        cancel(reason) {
          if (!child.killed && child.exitCode === null && child.signalCode === null) {
            child.kill(reason === "interrupt" ? "SIGINT" : "SIGTERM");
          }
        },
      };
    },
  };
}

export const cliOpenShellSandboxLogs = createCliOpenShellSandboxLogs();
