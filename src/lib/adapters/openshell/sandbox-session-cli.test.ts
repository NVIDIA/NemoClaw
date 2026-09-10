// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCliOpenShellSandboxSessionExecutor,
  type CliOpenShellSessionChild,
} from "./sandbox-command-cli";
import type { OpenShellSandboxSessionRequest } from "./sandbox-session";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const command: OpenShellSandboxSessionRequest = {
  kind: "command",
  sandboxName: "alpha",
  target: { kind: "named", gatewayName: "test-gateway" },
  command: ["openclaw", "agent", "-m", "hello"],
  tty: false,
  output: "capture",
  timeoutSeconds: 90,
};
function sessionHarness() {
  const events = new EventEmitter();
  const signals = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child: CliOpenShellSessionChild = {
    exitCode: null,
    signalCode: null,
    stdout,
    stderr,
    once: ((event: string, listener: (...args: unknown[]) => void) =>
      events.once(event, listener)) as CliOpenShellSessionChild["once"],
    kill: vi.fn(() => true),
  };
  const spawnChild = vi.fn(
    (
      _binary: string,
      _args: readonly string[],
      _options: {
        cwd?: string;
        env: NodeJS.ProcessEnv;
        stdio: import("node:child_process").StdioOptions;
      },
    ) => child,
  );
  const restoreTerminal = vi.fn();
  const executor = createCliOpenShellSandboxSessionExecutor({
    resolveBinary: () => "/bin/openshell",
    environment: { PATH: "/bin" },
    hostCwd: "/workspace",
    stdinIsTty: () => true,
    spawnChild,
    restoreTerminal,
    signalSource: {
      add: (signal, listener) => signals.on(signal, listener),
      remove: (signal, listener) => signals.off(signal, listener),
    },
  });
  return { events, signals, stdout, stderr, child, spawnChild, restoreTerminal, executor };
}
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockReset();
  vi.unstubAllEnvs();
  Object.defineProperty(
    process.stdin,
    "isTTY",
    originalTty ?? { configurable: true, value: undefined },
  );
  Object.defineProperty(
    process.stdin,
    "setRawMode",
    originalRawMode ?? { configurable: true, value: undefined },
  );
});

describe("OpenShell sessions", () => {
  it("captures a gateway-scoped command and withholds terminal stdin", async () => {
    const f = sessionHarness();
    const session = f.executor.start(command);
    expect(f.spawnChild).toHaveBeenCalledWith(
      "/bin/openshell",
      [
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "-g",
        "test-gateway",
        "--no-tty",
        "--timeout",
        "90",
        "--",
        "openclaw",
        "agent",
        "-m",
        "hello",
      ],
      { cwd: "/workspace", env: { PATH: "/bin" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    f.stdout.emit("data", "answer\n");
    f.stderr.emit("data", "diagnostic\n");
    f.events.emit("close", 7, null);
    expect(await session.completion).toMatchObject({
      outcome: { kind: "exited", exitCode: 7 },
      stdout: "answer\n",
      stderr: "diagnostic\n",
    });
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    expect(f.restoreTerminal).not.toHaveBeenCalled();
  });

  it("starts connect synchronously and releases signal ownership after terminal cleanup", async () => {
    const f = sessionHarness();
    const session = f.executor.start({
      kind: "connect",
      sandboxName: "alpha",
      target: { kind: "selected" },
    });
    expect(f.spawnChild).toHaveBeenCalledWith(
      "/bin/openshell",
      ["sandbox", "connect", "alpha"],
      expect.objectContaining({ stdio: ["inherit", "inherit", "inherit"] }),
    );
    f.signals.emit("SIGINT");
    expect(f.child.kill).not.toHaveBeenCalled();
    f.events.emit("close", 0, null);
    const completed = await session.completion;
    expect(completed.outcome).toEqual({ kind: "exited", exitCode: 0 });
    expect(f.restoreTerminal).toHaveBeenCalledOnce();
    expect(f.signals.listenerCount("SIGINT")).toBe(1);
    completed.release();
    expect(f.signals.listenerCount("SIGINT")).toBe(0);
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it.each([
    [255, null, { kind: "failed", reason: "transport", exitCode: 255 }],
    [null, "SIGHUP", { kind: "failed", reason: "transport", exitCode: 129 }],
    [null, "SIGPIPE", { kind: "failed", reason: "transport", exitCode: 141 }],
    [null, "SIGTERM", { kind: "signalled", signal: "SIGTERM", exitCode: 143 }],
    [null, null, { kind: "failed", reason: "transport", exitCode: 1 }],
  ])("classifies status %s and signal %s without retry", async (status, signal, outcome) => {
    const f = sessionHarness();
    const session = f.executor.start(command);
    f.events.emit("close", status, signal);
    expect((await session.completion).outcome).toMatchObject(outcome);
    expect(f.spawnChild).toHaveBeenCalledOnce();
  });

  it("cancels once and waits for child close", async () => {
    const f = sessionHarness();
    const session = f.executor.start(command);
    const completed = vi.fn();
    void session.completion.then(completed);
    session.cancel();
    session.cancel();
    await Promise.resolve();
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(completed).not.toHaveBeenCalled();
    f.events.emit("close", null, "SIGTERM");
    expect((await session.completion).outcome).toEqual({ kind: "cancelled", exitCode: 143 });
    session.cancel();
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it("forwards host termination and retains captured diagnostics", async () => {
    const f = sessionHarness();
    const session = f.executor.start(command);
    f.stderr.emit("data", "partial\n");
    f.signals.emit("SIGTERM");
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    f.events.emit("close", null, "SIGTERM");
    expect(await session.completion).toMatchObject({
      outcome: { kind: "signalled", signal: "SIGTERM", exitCode: 143 },
      stderr: "partial\n",
    });
  });

  it("reports the combined output bound as capture failure", async () => {
    const f = sessionHarness();
    const session = f.executor.start({ ...command, outputLimitBytes: 4 });
    f.stdout.emit("data", "123");
    f.stderr.emit("data", "45");
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    f.events.emit("close", null, "SIGTERM");
    expect(await session.completion).toMatchObject({
      outcome: { kind: "failed", reason: "capture", exitCode: 1 },
      stdout: "123",
      stderr: "",
    });
  });

  it("returns configuration failures without spawning", async () => {
    const f = sessionHarness();
    const session = f.executor.start({ ...command, sandboxName: "bad name" });
    expect((await session.completion).outcome).toMatchObject({
      kind: "failed",
      reason: "configuration",
    });
    expect(f.spawnChild).not.toHaveBeenCalled();
  });

  it("returns unavailable when the executable cannot be resolved", async () => {
    const executor = createCliOpenShellSandboxSessionExecutor({
      resolveBinary: () => null,
      environment: {},
    });
    expect((await executor.start(command).completion).outcome).toMatchObject({
      kind: "failed",
      reason: "unavailable",
      exitCode: 1,
    });
  });

  it("preserves invocation errors after child close", async () => {
    const f = sessionHarness();
    const session = f.executor.start(command);
    f.events.emit("error", Object.assign(new Error("missing executable"), { code: "ENOENT" }));
    f.events.emit("close", -2, null);
    expect((await session.completion).outcome).toEqual({
      kind: "failed",
      reason: "unavailable",
      message: "missing executable",
      exitCode: 1,
    });
  });
});

describe("session host policy", () => {
  it("filters the default environment and forwards redirected stdin", async () => {
    vi.stubEnv("GITHUB_TOKEN", "private-test-token");
    const f = sessionHarness();
    const executor = createCliOpenShellSandboxSessionExecutor({
      resolveBinary: () => "openshell",
      spawnChild: f.spawnChild,
      stdinIsTty: () => false,
    });
    const session = executor.start(command);
    expect(f.spawnChild.mock.calls[0]?.[2]).toMatchObject({
      stdio: ["inherit", "pipe", "pipe"],
      env: expect.not.objectContaining({ GITHUB_TOKEN: expect.anything() }),
    });
    f.events.emit("close", 0, null);
    await session.completion;
  });

  it("restores terminal modes after a disconnect", async () => {
    const rawMode = vi.fn();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: rawMode });
    const stty = vi
      .mocked(spawnSync)
      .mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    const f = sessionHarness();
    const executor = createCliOpenShellSandboxSessionExecutor({
      resolveBinary: () => "openshell",
      spawnChild: f.spawnChild,
      environment: {},
    });
    const session = executor.start({
      kind: "connect",
      sandboxName: "alpha",
      target: { kind: "selected" },
    });
    f.events.emit("close", 255, null);
    const completed = await session.completion;
    completed.release();
    expect(rawMode).toHaveBeenCalledWith(false);
    expect(stty).toHaveBeenCalledWith(
      "stty",
      ["sane"],
      expect.objectContaining({ stdio: ["inherit", "ignore", "ignore"] }),
    );
    expect(completed.outcome).toMatchObject({ reason: "transport", exitCode: 255 });
  });

  it("preserves the outcome when both terminal repairs throw", async () => {
    const rawMode = vi.fn(() => {
      throw new Error("raw mode failed");
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: rawMode });
    const stty = vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("stty failed");
    });
    const f = sessionHarness();
    const executor = createCliOpenShellSandboxSessionExecutor({
      resolveBinary: () => "openshell",
      spawnChild: f.spawnChild,
      environment: {},
    });
    const session = executor.start({
      kind: "connect",
      sandboxName: "alpha",
      target: { kind: "selected" },
    });
    f.events.emit("close", 255, null);
    const completed = await session.completion;
    completed.release();
    expect(stty).toHaveBeenCalledOnce();
    expect(completed.outcome).toMatchObject({ reason: "transport", exitCode: 255 });
  });

  it("skips terminal repair for redirected input", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    const stty = vi.mocked(spawnSync);
    const f = sessionHarness();
    const executor = createCliOpenShellSandboxSessionExecutor({
      resolveBinary: () => "openshell",
      spawnChild: f.spawnChild,
      environment: {},
    });
    const session = executor.start({
      kind: "connect",
      sandboxName: "alpha",
      target: { kind: "selected" },
    });
    f.events.emit("close", 0, null);
    (await session.completion).release();
    expect(stty).not.toHaveBeenCalled();
  });

  it("delivers a turn timeout reported after the requested agent deadline (#8723)", async () => {
    vi.useFakeTimers();
    const f = sessionHarness();
    const report = "Request timed out before a response was generated.\n";
    const executor = createCliOpenShellSandboxSessionExecutor({
      resolveBinary: () => "openshell",
      environment: {},
      stdinIsTty: () => true,
      spawnChild: (_binary, args) => {
        setTimeout(
          () => f.child.kill("SIGTERM"),
          Number(args[args.indexOf("--timeout") + 1]) * 1000,
        );
        setTimeout(() => {
          f.stdout.emit("data", report);
          f.events.emit("close", 0, null);
        }, 50800);
        return f.child;
      },
    });
    try {
      const session = executor.start({
        ...command,
        command: ["openclaw", "agent", "--timeout", "30", "-m", "ping"],
        timeoutSeconds: 60,
      });
      await vi.advanceTimersByTimeAsync(50800);
      expect(await session.completion).toMatchObject({
        outcome: { kind: "exited", exitCode: 0 },
        stdout: report,
      });
      expect(f.child.kill).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
