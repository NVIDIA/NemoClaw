// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  OpenShellSandboxLogFollowSession,
  OpenShellSandboxLogRequest,
  OpenShellSandboxLogs,
} from "../../adapters/openshell/sandbox-logs";
import { showSandboxLogsWithDeps } from "./logs";

vi.mock("../../runner", () => ({ ROOT: process.cwd() }));

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

function failExit(code: number): never {
  throw new ExitError(code);
}

type CapturedLogsRun = {
  errors: string[];
  exitCode: number | null;
  follows: OpenShellSandboxLogRequest[];
  reads: OpenShellSandboxLogRequest[];
  signalListenersRestored: boolean;
  stderr: string;
  stdout: string;
};

type FakeLogProbeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  errorKind?: "capture" | "configuration" | "invocation" | "timeout" | "unavailable";
  signal?: NodeJS.Signals | null;
};

function outcome(result: FakeLogProbeResult) {
  return result.error
    ? {
        kind: "failed" as const,
        error: { kind: result.errorKind ?? ("invocation" as const), message: result.error.message },
        exitCode: 1,
      }
    : {
        kind: "completed" as const,
        exitCode: result.status ?? 1,
        ...(result.signal
          ? {
              termination:
                result.signal === "SIGPIPE" ? ("broken_pipe" as const) : ("terminated" as const),
            }
          : {}),
      };
}

function restoreProcessSignalListeners(
  signal: NodeJS.Signals,
  before: NodeJS.SignalsListener[],
): void {
  for (const listener of process.listeners(signal)) {
    if (!before.includes(listener as NodeJS.SignalsListener)) {
      process.removeListener(signal, listener);
    }
  }
}

async function captureLogsRun(
  options: Parameters<typeof showSandboxLogsWithDeps>[1],
  results: Record<string, FakeLogProbeResult>,
  overrides: Partial<Parameters<typeof showSandboxLogsWithDeps>[2]> = {},
): Promise<CapturedLogsRun> {
  const followsLogs = typeof options === "boolean" ? options : options.follow;
  const reads: OpenShellSandboxLogRequest[] = [];
  const follows: OpenShellSandboxLogRequest[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  let signalListenersRestored = false;
  const sigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
  const sigtermListeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });

  const logs: OpenShellSandboxLogs = {
    checkAvailability: () => null,
    async read(request) {
      reads.push(request);
      const result = results[request.source === "gateway" ? "sandbox" : "logs"] ?? {
        status: 0,
      };
      return {
        content: String(result.stdout ?? ""),
        diagnostic: String(result.stderr ?? ""),
        outcome: outcome(result),
      };
    },
    follow(request) {
      follows.push(request);
      return {
        diagnostic: null,
        output: null,
        cancel() {},
        completion: Promise.resolve({
          outcome: { kind: "completed", exitCode: 0 },
        }),
      };
    },
  };

  try {
    await showSandboxLogsWithDeps("alpha", options, {
      exit: (code) => {
        exitCode = code;
        return followsLogs ? (undefined as never) : failExit(code);
      },
      isDockerRuntimeDown: () => false,
      logs,
      enableAuditLogs: async () => {
        const result = results.settings ?? { status: 0 };
        return result.status === 0
          ? { ok: true, value: undefined }
          : {
              ok: false,
              error: { kind: "command", reason: "failed", message: "settings unavailable" },
            };
      },
      writeStdout: (chunk) => {
        stdout.push(chunk);
      },
      writeStderr: (chunk) => {
        stderr.push(chunk);
      },
      ...overrides,
    });
    await (followsLogs ? new Promise<void>((resolve) => setImmediate(resolve)) : Promise.resolve());
  } catch (error) {
    if (!(error instanceof ExitError)) throw error;
  } finally {
    errorSpy.mockRestore();
    signalListenersRestored =
      process.listeners("SIGINT").every((listener, index) => listener === sigintListeners[index]) &&
      process.listeners("SIGINT").length === sigintListeners.length &&
      process
        .listeners("SIGTERM")
        .every((listener, index) => listener === sigtermListeners[index]) &&
      process.listeners("SIGTERM").length === sigtermListeners.length;
    restoreProcessSignalListeners("SIGINT", sigintListeners);
    restoreProcessSignalListeners("SIGTERM", sigtermListeners);
  }

  return {
    errors,
    exitCode,
    follows,
    reads,
    signalListenersRestored,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
}

describe("showSandboxLogsWithDeps", () => {
  it("enables audit logs, reads both log sources, and writes merged output", async () => {
    const result = await captureLogsRun(
      { follow: false, lines: "50", since: null },
      {
        settings: { status: 0 },
        sandbox: { status: 0, stdout: "[1] gateway\n" },
        logs: { status: 0, stdout: "[2] openshell\n" },
      },
    );

    expect(result.exitCode).toBe(0);
    // The gateway line names no subsystem, so the relay attributes it; the
    // OpenShell line already carries its own tag and is passed through (#10340).
    expect(result.stdout).toBe("[1] [gateway] gateway\n[2] openshell\n");
    expect(result.reads).toEqual([
      {
        target: { kind: "selected" },
        sandboxName: "alpha",
        source: "gateway",
        lines: "50",
        since: null,
        timeoutMs: 5000,
      },
      {
        target: { kind: "selected" },
        sandboxName: "alpha",
        source: "openshell",
        lines: "50",
        since: null,
        timeoutMs: 5000,
      },
    ]);
  });

  it("skips the OpenClaw gateway tail when --since targets OpenShell logs", async () => {
    const result = await captureLogsRun(
      { follow: false, lines: "200", since: "5m" },
      {
        settings: { status: 0 },
        logs: { status: 0, stdout: "[3] openshell only\n" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[3] openshell only\n");
    expect(result.reads).toEqual([
      {
        target: { kind: "selected" },
        sandboxName: "alpha",
        source: "openshell",
        lines: "200",
        since: "5m",
        timeoutMs: 5000,
      },
    ]);
  });

  it("streams follow logs with the requested tail count", async () => {
    const result = await captureLogsRun(
      { follow: true, lines: "50", since: null },
      {
        settings: { status: 0 },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.signalListenersRestored).toBe(true);
    expect(result.reads).toEqual([]);
    expect(result.follows).toEqual([
      {
        target: { kind: "selected" },
        sandboxName: "alpha",
        source: "gateway",
        lines: "50",
        since: null,
        timeoutMs: 5000,
      },
      {
        target: { kind: "selected" },
        sandboxName: "alpha",
        source: "openshell",
        lines: "50",
        since: null,
        timeoutMs: 5000,
      },
    ]);
  });

  it("streams follow logs with --since through OpenShell without an unfiltered gateway tail", async () => {
    const result = await captureLogsRun(
      { follow: true, lines: "200", since: "5m" },
      {
        settings: { status: 0 },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.reads).toEqual([]);
    expect(result.follows).toEqual([
      {
        target: { kind: "selected" },
        sandboxName: "alpha",
        source: "openshell",
        lines: "200",
        since: "5m",
        timeoutMs: 5000,
      },
    ]);
  });

  it("warns about degraded audit and OpenClaw sources while continuing to OpenShell logs", async () => {
    const timeout = new Error("spawn openshell ETIMEDOUT");
    const result = await captureLogsRun(
      { follow: false, lines: "200", since: null },
      {
        settings: { status: 7, stderr: "settings unavailable\n" },
        sandbox: { status: null, stderr: "gateway diagnostic\n", error: timeout },
        logs: { status: 0, stdout: "[4] openshell fallback\n" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[4] openshell fallback\n");
    expect(result.stderr).toBe("gateway diagnostic\n");
    expect(result.errors.join("\n")).toContain(
      "failed to enable OpenShell audit logs for sandbox 'alpha'",
    );
    expect(result.errors.join("\n")).toContain("settings unavailable");
    expect(result.errors.join("\n")).toContain("Policy denial events may be missing");
    expect(result.errors.join("\n")).toContain(
      "OpenClaw log source unavailable (spawn openshell ETIMEDOUT)",
    );
  });

  it("prints Docker outage guidance and exits before OpenShell log probes", async () => {
    const guidance = vi.fn();
    const result = await captureLogsRun(
      { follow: false, lines: "200", since: null },
      {},
      {
        isDockerRuntimeDown: () => true,
        printDockerRuntimeDownGuidance: guidance,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(guidance).toHaveBeenCalledWith("alpha", { retryCommand: "logs" });
    expect(result.reads).toEqual([]);
    expect(result.follows).toEqual([]);
  });

  it("prints OpenShell installation guidance and exits before a second log probe", async () => {
    const exit = vi.fn(failExit);
    const result = await captureLogsRun(
      { follow: false, lines: "200", since: null },
      {
        settings: { status: 0 },
        sandbox: {
          status: null,
          error: new Error("OpenShell binary not found"),
          errorKind: "unavailable",
        },
      },
      { exit },
    );

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(result.errors).toEqual([
      "openshell CLI not found. Install OpenShell before using sandbox commands.",
    ]);
    expect(result.reads.map(({ source }) => source)).toEqual(["gateway"]);
  });

  it("surfaces a sparse gateway breadcrumb when OpenShell output dominates the tail", async () => {
    const gatewayStdout = [
      "[1779488800.000] [gateway] starting HTTP server",
      "[1779488815.000] [telegram] [default] bridge did not start within 15s; check channels.telegram.enabled, plugin entries, and gateway log",
    ].join("\n");
    const openshellStdout = Array.from(
      { length: 200 },
      (_v, i) => `[${1779488900 + i}.000] [sandbox] [INFO ] line ${i}`,
    ).join("\n");
    const result = await captureLogsRun(
      { follow: false, lines: "200", since: null },
      {
        settings: { status: 0 },
        sandbox: { status: 0, stdout: `${gatewayStdout}\n` },
        logs: { status: 0, stdout: `${openshellStdout}\n` },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bridge did not start within 15s");
    expect(result.stdout).toContain("starting HTTP server");
  });
});

type FakeFollowChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => boolean>>;
};

type StreamingChild = {
  child: FakeFollowChild;
  session: OpenShellSandboxLogFollowSession;
  stderr: PassThrough;
  stdout: PassThrough;
};

function createStreamingChild(withOutput = true): StreamingChild {
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn<(signal: NodeJS.Signals) => boolean>(() => true),
  });
  const completion = new Promise<Awaited<OpenShellSandboxLogFollowSession["completion"]>>(
    (resolve) => {
      child.on("error", (error: Error) => {
        resolve({
          outcome: {
            kind: "failed",
            error: { kind: "invocation", message: error.message },
            exitCode: 1,
          },
        });
      });
      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        resolve({
          outcome: {
            kind: "completed",
            exitCode: signal === "SIGPIPE" ? 141 : signal ? 143 : (code ?? 1),
            ...(signal
              ? {
                  termination:
                    signal === "SIGPIPE"
                      ? ("broken_pipe" as const)
                      : signal === "SIGINT"
                        ? ("interrupted" as const)
                        : ("terminated" as const),
                }
              : {}),
          },
        });
      });
    },
  );
  const session: OpenShellSandboxLogFollowSession = {
    completion,
    diagnostic: {
      onChunk(listener) {
        stderr.on("data", (chunk) => listener(String(chunk)));
      },
      onEnd(listener) {
        stderr.on("end", listener);
      },
      onError(listener) {
        stderr.on("error", listener);
      },
      pause: () => stderr.pause(),
      resume: () => stderr.resume(),
      close: () => stderr.destroy(),
    },
    output: withOutput
      ? {
          onChunk(listener) {
            stdout.on("data", (chunk) => listener(String(chunk)));
          },
          onEnd(listener) {
            stdout.on("end", listener);
          },
          onError(listener) {
            stdout.on("error", listener);
          },
          pause: () => stdout.pause(),
          resume: () => stdout.resume(),
          close: () => stdout.destroy(),
        }
      : null,
    cancel: (reason) => {
      child.kill(reason === "interrupt" ? "SIGINT" : "SIGTERM");
    },
  };
  return { child, session, stderr, stdout };
}

type FollowRun = {
  diagnostics: string[];
  written: string[];
  gateway: StreamingChild;
  openshell: StreamingChild | null;
  output: Writable;
  exited: Promise<number>;
};

function createCapturedOutput(written: string[]): PassThrough {
  const output = new PassThrough();
  output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
  return output;
}

async function startFollowRun(
  options: {
    diagnosticOutput?: Writable;
    output?: Writable;
    keepOpenshellRunning?: boolean;
  } = {},
): Promise<FollowRun> {
  const diagnostics: string[] = [];
  const written: string[] = [];
  let spawnCount = 0;
  const gateway = createStreamingChild();
  const openshell = options.keepOpenshellRunning ? createStreamingChild(false) : null;
  const output = options.output ?? createCapturedOutput(written);
  const sigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
  const sigtermListeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });

  const logs: OpenShellSandboxLogs = {
    checkAvailability: () => null,
    read: vi.fn(),
    follow() {
      spawnCount += 1;
      return spawnCount === 1
        ? gateway.session
        : (openshell?.session ?? {
            diagnostic: null,
            output: null,
            cancel() {},
            completion: Promise.resolve({ outcome: { kind: "completed", exitCode: 0 } }),
          });
    },
  };

  await showSandboxLogsWithDeps(
    "alpha",
    { follow: true, lines: "50", since: null },
    {
      exit: ((code: number) => {
        restoreProcessSignalListeners("SIGINT", sigintListeners);
        restoreProcessSignalListeners("SIGTERM", sigtermListeners);
        settle(code);
        return undefined as never;
      }) as never,
      isDockerRuntimeDown: () => false,
      logs,
      enableAuditLogs: async () => ({ ok: true, value: undefined }),
      stdout: output,
      ...(options.diagnosticOutput
        ? { stderr: options.diagnosticOutput }
        : {
            writeStderr: (chunk: string) => {
              diagnostics.push(chunk);
            },
          }),
    },
  );

  return { diagnostics, written, gateway, openshell, output, exited };
}

class DeferredOutput extends Writable {
  readonly chunks: string[] = [];
  private pendingWrite: (() => void) | null = null;

  constructor(highWaterMark = 1) {
    super({ highWaterMark });
  }

  get hasPendingWrite(): boolean {
    return this.pendingWrite !== null;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString("utf8"));
    this.pendingWrite = callback;
  }

  release(): void {
    const callback = this.pendingWrite;
    this.pendingWrite = null;
    callback?.();
  }
}

describe("follow-mode log source attribution (#10340)", () => {
  const BANNER = [
    "│",
    "◆  Config warnings ────",
    "│  - plugins.entries.tavily: plugin not installed: tavily - install the",
    "└────",
  ].join("\n");

  it("exits follow mode with guidance before audit setup when OpenShell is unavailable", async () => {
    const follow = vi.fn();
    const enableAuditLogs = vi.fn();
    const exit = vi.fn(failExit);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        showSandboxLogsWithDeps(
          "alpha",
          { follow: true, lines: "50", since: null },
          {
            enableAuditLogs,
            exit,
            isDockerRuntimeDown: () => false,
            logs: {
              checkAvailability: () => ({
                kind: "unavailable",
                message: "OpenShell binary not found",
              }),
              read: vi.fn(),
              follow,
            },
          },
        ),
      ).rejects.toMatchObject({ code: 1 });

      expect(errorSpy).toHaveBeenCalledWith(
        "openshell CLI not found. Install OpenShell before using sandbox commands.",
      );
      expect(exit).toHaveBeenCalledOnce();
      expect(follow).not.toHaveBeenCalled();
      expect(enableAuditLogs).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not start an OpenShell follower after interruption during audit enablement", async () => {
    const gateway = createStreamingChild();
    const follow = vi.fn(() => gateway.session);
    const sigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
    const sigtermListeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
    let resolveAudit: (result: { ok: true; value: undefined }) => void = () => {};
    const auditResult = new Promise<{ ok: true; value: undefined }>((resolve) => {
      resolveAudit = resolve;
    });
    let settleExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      settleExit = resolve;
    });

    try {
      const setup = showSandboxLogsWithDeps(
        "alpha",
        { follow: true, lines: "50", since: null },
        {
          enableAuditLogs: () => auditResult,
          exit: ((code: number) => {
            settleExit(code);
            return undefined as never;
          }) as never,
          isDockerRuntimeDown: () => false,
          logs: { checkAvailability: () => null, read: vi.fn(), follow },
          stdout: createCapturedOutput([]),
        },
      );

      expect(follow).toHaveBeenCalledOnce();
      process.emit("SIGINT");
      expect(gateway.child.kill).toHaveBeenCalledWith("SIGINT");

      resolveAudit({ ok: true, value: undefined });
      await setup;
      expect(follow).toHaveBeenCalledOnce();

      gateway.stdout.end();
      gateway.child.emit("exit", null, "SIGINT");
      await expect(exited).resolves.toBe(130);
    } finally {
      restoreProcessSignalListeners("SIGINT", sigintListeners);
      restoreProcessSignalListeners("SIGTERM", sigtermListeners);
    }
  });

  it("cancels an active gateway follower when OpenShell becomes unavailable", async () => {
    const gateway = createStreamingChild();
    const unavailableCancel = vi.fn();
    const unavailable: OpenShellSandboxLogFollowSession = {
      completion: Promise.resolve({
        outcome: {
          kind: "failed",
          error: { kind: "unavailable", message: "OpenShell binary not found" },
          exitCode: 1,
        },
      }),
      diagnostic: null,
      output: null,
      cancel: unavailableCancel,
    };
    const follow = vi
      .fn<OpenShellSandboxLogs["follow"]>()
      .mockReturnValueOnce(gateway.session)
      .mockReturnValueOnce(unavailable);
    const sigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
    const sigtermListeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let settleExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      settleExit = resolve;
    });

    try {
      await showSandboxLogsWithDeps(
        "alpha",
        { follow: true, lines: "50", since: null },
        {
          enableAuditLogs: async () => ({ ok: true, value: undefined }),
          exit: ((code: number) => {
            settleExit(code);
            return undefined as never;
          }) as never,
          isDockerRuntimeDown: () => false,
          logs: { checkAvailability: () => null, read: vi.fn(), follow },
          stdout: createCapturedOutput([]),
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(errorSpy).toHaveBeenCalledWith(
        "openshell CLI not found. Install OpenShell before using sandbox commands.",
      );
      expect(gateway.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(unavailableCancel).toHaveBeenCalledWith("terminate");

      gateway.stdout.end();
      gateway.child.emit("exit", null, "SIGTERM");
      await expect(exited).resolves.toBe(1);
    } finally {
      errorSpy.mockRestore();
      restoreProcessSignalListeners("SIGINT", sigintListeners);
      restoreProcessSignalListeners("SIGTERM", sigtermListeners);
    }
  });

  it("relays typed source diagnostics to stderr", async () => {
    const run = await startFollowRun({ keepOpenshellRunning: true });
    run.openshell?.stderr.write("safe OpenShell diagnostic\n");
    run.openshell?.child.emit("exit", 0, null);
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);

    await expect(run.exited).resolves.toBe(0);
    expect(run.diagnostics).toEqual(["safe OpenShell diagnostic\n"]);
  });

  it("pauses followed diagnostics until stderr drains and releases the listener", async () => {
    const diagnosticOutput = new DeferredOutput();
    const run = await startFollowRun({ diagnosticOutput, keepOpenshellRunning: true });
    const openshell = run.openshell as StreamingChild;

    openshell.stderr.write("diagnostic line\n");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(openshell.stderr.isPaused()).toBe(true);
    expect(diagnosticOutput.listenerCount("drain")).toBe(1);

    const drained = once(diagnosticOutput, "drain");
    diagnosticOutput.release();
    await drained;
    expect(openshell.stderr.isPaused()).toBe(false);

    openshell.child.emit("exit", 0, null);
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await expect(run.exited).resolves.toBe(0);

    expect(diagnosticOutput.listenerCount("drain")).toBe(0);
    expect(openshell.stderr.destroyed).toBe(true);
  });

  it("attributes every streamed banner line to a source", async () => {
    const run = await startFollowRun();
    run.gateway.stdout.write(`${BANNER}\n`);
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await run.exited;

    const lines = run.written.join("").split("\n").filter(Boolean);
    expect(lines).toEqual(BANNER.split("\n").map((line) => `[gateway] ${line}`));
  });

  it("emits a trailing line that arrives without a newline", async () => {
    const run = await startFollowRun();
    run.gateway.stdout.write("no trailing newline");
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await run.exited;

    expect(run.written.join("")).toBe("[gateway] no trailing newline\n");
  });

  it.each([
    {
      position: "at stream completion",
      chunks: ["message\r"],
      expected: "[gateway] message\r\n",
    },
    {
      position: "before non-newline content",
      chunks: ["message\r", "continued"],
      expected: "[gateway] message\rcontinued\n",
    },
  ])("preserves a bare carriage return $position (#10340)", async ({ chunks, expected }) => {
    const run = await startFollowRun();
    chunks.forEach((chunk) => run.gateway.stdout.write(chunk));
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await run.exited;

    expect(run.written.join("")).toBe(expected);
  });

  it("stops following when the source exits while a descendant holds its stdout open", async () => {
    // A grandchild that inherited the child's stdout write end keeps `end` from
    // firing. Completion must not require `end`, or follow mode hangs forever.
    const run = await startFollowRun();
    run.gateway.stdout.write("gateway banner line\n");
    run.gateway.child.emit("exit", 0, null);

    await expect(run.exited).resolves.toBe(0);
    expect(run.written.join("")).toBe("[gateway] gateway banner line\n");
  });

  it("streams a long unterminated line before the source completes (#10340)", async () => {
    const run = await startFollowRun();
    const line = "x".repeat(1_000_000);
    run.gateway.stdout.write(line);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(run.written.join("")).toBe(`[gateway] ${line}`);

    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await expect(run.exited).resolves.toBe(0);
    expect(run.written.join("")).toBe(`[gateway] ${line}\n`);
  });

  it("normalizes CRLF delimiters split across source chunks (#10340)", async () => {
    const run = await startFollowRun();
    const longLine = "x".repeat(4_097);
    run.gateway.stdout.write("short line\r");
    run.gateway.stdout.write(`\n${longLine}\r`);
    run.gateway.stdout.write("\n");
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);

    await expect(run.exited).resolves.toBe(0);
    expect(run.written.join("")).toBe(`[gateway] short line\n[gateway] ${longLine}\n`);
  });

  it("pauses the gateway source until log output drains (#10340)", async () => {
    const output = new DeferredOutput();
    const run = await startFollowRun({ output });
    run.gateway.stdout.write("gateway line\n");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(run.gateway.stdout.isPaused()).toBe(true);
    const drained = once(output, "drain");
    output.release();
    await drained;
    expect(run.gateway.stdout.isPaused()).toBe(false);

    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await expect(run.exited).resolves.toBe(0);
    expect(output.chunks.join("")).toBe("[gateway] gateway line\n");
  });

  it("relays buffered source data after output drains following child exit (#10340)", async () => {
    vi.useFakeTimers();
    try {
      const output = new DeferredOutput();
      const run = await startFollowRun({ output });
      run.gateway.stdout.write("first line\n");
      run.gateway.stdout.write("second line\n");
      run.gateway.stdout.end();
      run.gateway.child.emit("exit", 0, null);

      await vi.advanceTimersByTimeAsync(201);
      expect(output.chunks.join("")).toBe("[gateway] first line\n");

      output.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(output.chunks.join("")).toBe("[gateway] first line\n[gateway] second line\n");

      output.release();
      await vi.runAllTimersAsync();
      await expect(run.exited).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for accepted output writes before reporting success (#10340)", async () => {
    const output = new DeferredOutput(1_024);
    const run = await startFollowRun({ output });
    let exitCode: number | null = null;
    void run.exited.then((code) => {
      exitCode = code;
    });

    run.gateway.stdout.write("gateway line\n");
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(output.writableNeedDrain).toBe(false);
    expect(output.hasPendingWrite).toBe(true);
    expect(exitCode).toBeNull();

    output.release();
    await expect(run.exited).resolves.toBe(0);
  });

  it("waits for accepted output writes before reporting a tagged child error (#10340)", async () => {
    const output = new DeferredOutput(1_024);
    const run = await startFollowRun({ output });
    let exitCode: number | null = null;
    void run.exited.then((code) => {
      exitCode = code;
    });

    run.gateway.stdout.write("gateway line\n");
    run.gateway.child.emit("error", new Error("log source failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(output.writableNeedDrain).toBe(false);
    expect(output.hasPendingWrite).toBe(true);
    expect(exitCode).toBeNull();

    output.release();
    await expect(run.exited).resolves.toBe(1);
  });

  it("terminates both log sources after a downstream broken pipe (#10340)", async () => {
    const output = new PassThrough();
    const run = await startFollowRun({ output, keepOpenshellRunning: true });
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    output.emit("error", error);

    expect(run.gateway.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(run.openshell?.child.kill).toHaveBeenCalledWith("SIGTERM");
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", null, "SIGTERM");
    run.openshell?.child.emit("exit", null, "SIGTERM");
    await expect(run.exited).resolves.toBe(141);
  });

  it("terminates the gateway source after the raw source receives SIGPIPE (#10340)", async () => {
    const run = await startFollowRun({ keepOpenshellRunning: true });
    const openshell = run.openshell as StreamingChild;

    Object.assign(openshell.child, { signalCode: "SIGPIPE" });
    openshell.child.emit("exit", null, "SIGPIPE");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(run.gateway.child.kill).toHaveBeenCalledWith("SIGTERM");
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", null, "SIGTERM");
    await expect(run.exited).resolves.toBe(141);
  });

  it("reports a non-pipe output error and stops the gateway source (#10340)", async () => {
    const output = new PassThrough();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = await startFollowRun({ output });
      const error = Object.assign(new Error("no space"), { code: "ENOSPC" });

      output.emit("error", error);
      expect(run.gateway.child.kill).toHaveBeenCalledWith("SIGTERM");
      run.gateway.stdout.end();
      run.gateway.child.emit("exit", null, "SIGTERM");

      await expect(run.exited).resolves.toBe(1);
      expect(errorSpy).toHaveBeenCalledWith("  Log output failed (ENOSPC).");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("reports a gateway read error instead of a successful stop (#10340)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = await startFollowRun();
      const error = Object.assign(new Error("read failed"), { code: "EIO" });

      run.gateway.stdout.emit("error", error);

      await expect(run.exited).resolves.toBe(1);
      expect(run.gateway.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(errorSpy).toHaveBeenCalledWith("  OpenClaw log source read failed (EIO).");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("reports a source read error after the drain interval starts finalization (#10340)", async () => {
    vi.useFakeTimers();
    const output = new DeferredOutput();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = await startFollowRun({ output });
      run.gateway.stdout.write("gateway line");
      run.gateway.child.emit("exit", 0, null);

      await vi.advanceTimersByTimeAsync(200);
      expect(output.hasPendingWrite).toBe(true);

      const error = Object.assign(new Error("read failed"), { code: "EIO" });
      run.gateway.stdout.emit("error", error);
      output.release();
      await vi.runAllTimersAsync();

      await expect(run.exited).resolves.toBe(1);
      expect(errorSpy).toHaveBeenCalledWith("  OpenClaw log source read failed (EIO).");
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
