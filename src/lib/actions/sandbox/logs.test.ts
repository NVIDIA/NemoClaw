// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { LogProbeResult } from "../../domain/sandbox/logs";
import { showSandboxLogsWithDeps } from "./logs";

vi.mock("../../runner", () => ({ ROOT: process.cwd() }));

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

type CapturedLogsRun = {
  calls: { args: string[]; options: Record<string, unknown> }[];
  errors: string[];
  exitCode: number | null;
  spawns: { command: string; args: string[]; options: Record<string, unknown> }[];
  stdout: string;
};

type SandboxLogsDeps = NonNullable<Parameters<typeof showSandboxLogsWithDeps>[2]>;
type SpawnFn = NonNullable<SandboxLogsDeps["spawn"]>;

function createExitedChild(): ReturnType<SpawnFn> {
  const child = new EventEmitter() as ReturnType<SpawnFn>;
  Object.assign(child, {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  const originalOn = child.on.bind(child);
  child.on = ((eventName: string, listener: (...args: unknown[]) => void) => {
    originalOn(eventName, listener);
    if (eventName === "exit") {
      listener(0, null);
    }
    return child;
  }) as typeof child.on;
  return child;
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

function captureLogsRun(
  options: Parameters<typeof showSandboxLogsWithDeps>[1],
  results: Record<string, LogProbeResult>,
  overrides: Partial<Parameters<typeof showSandboxLogsWithDeps>[2]> = {},
): CapturedLogsRun {
  const calls: CapturedLogsRun["calls"] = [];
  const spawns: CapturedLogsRun["spawns"] = [];
  const stdout: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  const sigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
  const sigtermListeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });

  const runOpenshell = vi.fn((args: string[], callOptions = {}) => {
    calls.push({ args, options: callOptions as Record<string, unknown> });
    return results[args[0]] ?? { status: 0 };
  });
  const spawn = ((command: string, args: readonly string[], callOptions = {}) => {
    spawns.push({
      command,
      args: [...args],
      options: callOptions as Record<string, unknown>,
    });
    return createExitedChild();
  }) as unknown as SpawnFn;

  try {
    showSandboxLogsWithDeps("alpha", options, {
      exit: (code) => {
        exitCode = code;
        throw new ExitError(code);
      },
      isDockerRuntimeDown: () => false,
      getOpenshellBinary: () => "openshell",
      runOpenshell,
      spawn,
      writeStdout: (chunk) => {
        stdout.push(chunk);
      },
      ...overrides,
    });
  } catch (error) {
    if (!(error instanceof ExitError)) throw error;
  } finally {
    errorSpy.mockRestore();
    restoreProcessSignalListeners("SIGINT", sigintListeners);
    restoreProcessSignalListeners("SIGTERM", sigtermListeners);
  }

  return { calls, errors, exitCode, spawns, stdout: stdout.join("") };
}

describe("showSandboxLogsWithDeps", () => {
  it("enables audit logs, reads both log sources, and writes merged output", () => {
    const result = captureLogsRun(
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
    expect(result.calls.map((call) => call.args)).toEqual([
      ["settings", "set", "alpha", "--key", "ocsf_json_enabled", "--value", "true"],
      ["sandbox", "exec", "-n", "alpha", "--", "tail", "-n", "50", "/tmp/gateway.log"],
      ["logs", "alpha", "-n", "50", "--source", "all"],
    ]);
  });

  it("skips the OpenClaw gateway tail when --since targets OpenShell logs", () => {
    const result = captureLogsRun(
      { follow: false, lines: "200", since: "5m" },
      {
        settings: { status: 0 },
        logs: { status: 0, stdout: "[3] openshell only\n" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[3] openshell only\n");
    expect(result.calls.map((call) => call.args)).toEqual([
      ["settings", "set", "alpha", "--key", "ocsf_json_enabled", "--value", "true"],
      ["logs", "alpha", "-n", "200", "--source", "all", "--since", "5m"],
    ]);
  });

  it("streams follow logs with the requested tail count", () => {
    const result = captureLogsRun(
      { follow: true, lines: "50", since: null },
      {
        settings: { status: 0 },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call.args)).toEqual([
      ["settings", "set", "alpha", "--key", "ocsf_json_enabled", "--value", "true"],
    ]);
    expect(result.spawns.map((call) => call.command)).toEqual(["openshell", "openshell"]);
    expect(result.spawns.map((call) => call.args)).toEqual([
      ["sandbox", "exec", "-n", "alpha", "--", "tail", "-n", "50", "-f", "/tmp/gateway.log"],
      ["logs", "alpha", "-n", "50", "--source", "all", "--tail"],
    ]);
  });

  it("streams follow logs with --since through OpenShell without an unfiltered gateway tail", () => {
    const result = captureLogsRun(
      { follow: true, lines: "200", since: "5m" },
      {
        settings: { status: 0 },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call.args)).toEqual([
      ["settings", "set", "alpha", "--key", "ocsf_json_enabled", "--value", "true"],
    ]);
    expect(result.spawns.map((call) => call.args)).toEqual([
      ["logs", "alpha", "-n", "200", "--source", "all", "--since", "5m", "--tail"],
    ]);
  });

  it("warns about degraded audit and OpenClaw sources while continuing to OpenShell logs", () => {
    const timeout = new Error("spawn openshell ETIMEDOUT");
    const result = captureLogsRun(
      { follow: false, lines: "200", since: null },
      {
        settings: { status: 7, stderr: "settings unavailable\n" },
        sandbox: { status: null, error: timeout },
        logs: { status: 0, stdout: "[4] openshell fallback\n" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[4] openshell fallback\n");
    expect(result.errors.join("\n")).toContain(
      "failed to enable OpenShell audit logs for sandbox 'alpha' (exit 7)",
    );
    expect(result.errors.join("\n")).toContain("settings unavailable");
    expect(result.errors.join("\n")).toContain("Policy denial events may be missing");
    expect(result.errors.join("\n")).toContain(
      "OpenClaw log source unavailable (spawn openshell ETIMEDOUT)",
    );
  });

  it("prints Docker outage guidance and exits before OpenShell log probes", () => {
    const guidance = vi.fn();
    const result = captureLogsRun(
      { follow: false, lines: "200", since: null },
      {},
      {
        isDockerRuntimeDown: () => true,
        printDockerRuntimeDownGuidance: guidance,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(guidance).toHaveBeenCalledWith("alpha", { retryCommand: "logs" });
    expect(result.calls).toEqual([]);
  });

  it("surfaces a sparse gateway breadcrumb when OpenShell output dominates the tail", () => {
    const gatewayStdout = [
      "[1779488800.000] [gateway] starting HTTP server",
      "[1779488815.000] [telegram] [default] bridge did not start within 15s; check channels.telegram.enabled, plugin entries, and gateway log",
    ].join("\n");
    const openshellStdout = Array.from(
      { length: 200 },
      (_v, i) => `[${1779488900 + i}.000] [sandbox] [INFO ] line ${i}`,
    ).join("\n");
    const result = captureLogsRun(
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

type StreamingChild = { child: ReturnType<SpawnFn>; stdout: PassThrough };

function createStreamingChild(): StreamingChild {
  const stdout = new PassThrough();
  const child = new EventEmitter() as ReturnType<SpawnFn>;
  Object.assign(child, {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    stdout,
  });
  return { child, stdout };
}

type FollowRun = {
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

function startFollowRun(
  options: { output?: Writable; keepOpenshellRunning?: boolean } = {},
): FollowRun {
  const written: string[] = [];
  let spawnCount = 0;
  const gateway = createStreamingChild();
  const openshell = options.keepOpenshellRunning ? createStreamingChild() : null;
  const output = options.output ?? createCapturedOutput(written);
  const sigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
  const sigtermListeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });

  const spawn = ((_command: string, _args: readonly string[], _callOptions = {}) => {
    spawnCount += 1;
    return spawnCount === 1 ? gateway.child : (openshell?.child ?? createExitedChild());
  }) as unknown as SpawnFn;

  showSandboxLogsWithDeps(
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
      getOpenshellBinary: () => "openshell",
      runOpenshell: vi.fn(() => ({ status: 0 })),
      spawn,
      stdout: output,
    },
  );

  return { written, gateway, openshell, output, exited };
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

  it("attributes every streamed banner line to a source", async () => {
    const run = startFollowRun();
    run.gateway.stdout.write(`${BANNER}\n`);
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await run.exited;

    const lines = run.written.join("").split("\n").filter(Boolean);
    expect(lines).toEqual(BANNER.split("\n").map((line) => `[gateway] ${line}`));
  });

  it("emits a trailing line that arrives without a newline", async () => {
    const run = startFollowRun();
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
    const run = startFollowRun();
    chunks.forEach((chunk) => run.gateway.stdout.write(chunk));
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", 0, null);
    await run.exited;

    expect(run.written.join("")).toBe(expected);
  });

  it("stops following when the source exits while a descendant holds its stdout open", async () => {
    // A grandchild that inherited the child's stdout write end keeps `end` from
    // firing. Completion must not require `end`, or follow mode hangs forever.
    const run = startFollowRun();
    run.gateway.stdout.write("gateway banner line\n");
    run.gateway.child.emit("exit", 0, null);

    await expect(run.exited).resolves.toBe(0);
    expect(run.written.join("")).toBe("[gateway] gateway banner line\n");
  });

  it("streams a long unterminated line before the source completes (#10340)", async () => {
    const run = startFollowRun();
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
    const run = startFollowRun();
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
    const run = startFollowRun({ output });
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
      const run = startFollowRun({ output });
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
    const run = startFollowRun({ output });
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
    const run = startFollowRun({ output });
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
    const run = startFollowRun({ output, keepOpenshellRunning: true });
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
    const run = startFollowRun({ keepOpenshellRunning: true });
    const openshell = run.openshell as StreamingChild;

    Object.assign(openshell.child, { signalCode: "SIGPIPE" });
    openshell.child.emit("exit", null, "SIGPIPE");

    expect(run.gateway.child.kill).toHaveBeenCalledWith("SIGTERM");
    run.gateway.stdout.end();
    run.gateway.child.emit("exit", null, "SIGTERM");
    await expect(run.exited).resolves.toBe(141);
  });

  it("reports a non-pipe output error and stops the gateway source (#10340)", async () => {
    const output = new PassThrough();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = startFollowRun({ output });
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
      const run = startFollowRun();
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
      const run = startFollowRun({ output });
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
