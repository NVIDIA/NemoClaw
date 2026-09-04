// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCliOpenShellSandboxExecArgs,
  createCliOpenShellSandboxCommandExecutor,
  type OpenShellCommandChild,
  type OpenShellCommandSignalSource,
} from "./sandbox-command-cli";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";

function completedChild(
  status: number | null,
  signal: NodeJS.Signals | null = null,
): OpenShellCommandChild {
  const events = new EventEmitter();
  const child: OpenShellCommandChild = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    once: ((event: string, listener: (...args: unknown[]) => void) => {
      events.once(event, listener);
      const notify = {
        error: () => undefined,
        close: () => queueMicrotask(() => events.emit("close", status, signal)),
      }[event as "error" | "close"];
      notify();
      return child;
    }) as OpenShellCommandChild["once"],
  };
  return child;
}

describe("CLI OpenShell sandbox command executor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps exact command bytes and CLI flags inside the implementation", () => {
    const command = ["python3", "-c", "print('one')\nprint('two')"];
    expect(
      buildCliOpenShellSandboxExecArgs({
        sandboxName: "alpha",
        target: namedOpenShellGateway("nemoclaw-8091"),
        command,
        workdir: "/sandbox/work space",
        tty: false,
        timeoutSeconds: 30,
        stdin: true,
      }),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8091",
      "--workdir",
      "/sandbox/work space",
      "--no-tty",
      "--timeout",
      "30",
      "--",
      ...command,
    ]);
  });

  it("streams with the configured host process authority and preserves a remote nonzero exit", async () => {
    const spawnChild = vi.fn(() => completedChild(42));
    const hostEnv = { PATH: "/trusted/bin" };
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      spawnChild,
      hostCwd: "/repo",
      hostEnv,
    });

    const completed = await executor.runStreaming({
      sandboxName: "alpha",
      target: selectedOpenShellGateway(),
      command: ["false"],
      stdin: false,
    });

    expect(completed.outcome).toEqual({ kind: "completed", exitCode: 42 });
    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "exec", "--name", "alpha", "--", "false"],
      { stdin: false, hostCwd: "/repo", hostEnv },
    );
    completed.release();
  });

  it("distinguishes an unavailable executable without spawning", async () => {
    const spawnChild = vi.fn();
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => null,
      spawnChild,
    });

    const completed = await executor.runStreaming({
      sandboxName: "alpha",
      target: selectedOpenShellGateway(),
      command: ["true"],
    });

    expect(completed.outcome).toEqual({
      kind: "failed",
      error: { kind: "unavailable", message: "OpenShell binary not found" },
    });
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("distinguishes a host timeout from a remote nonzero exit", async () => {
    const timeout = Object.assign(new Error("OpenShell command timed out"), {
      code: "ETIMEDOUT",
    });
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      spawnChild: () => {
        throw timeout;
      },
    });

    const completed = await executor.runStreaming({
      sandboxName: "alpha",
      target: selectedOpenShellGateway(),
      command: ["sleep", "30"],
    });

    expect(completed.outcome).toEqual({
      kind: "failed",
      error: { kind: "timeout", message: "OpenShell command timed out" },
    });
  });

  it.each([
    ["an unavailable executable", "ENOENT", "unavailable"],
    ["an unclassified transport failure", undefined, "invocation"],
  ] as const)("maps an asynchronous child error from %s", async (_label, code, kind) => {
    const events = new EventEmitter();
    const error = Object.assign(new Error("child process failed"), code ? { code } : {});
    const child: OpenShellCommandChild = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      once: ((event: string, listener: (...args: unknown[]) => void) => {
        events.once(event, listener);
        const notify = {
          error: () => undefined,
          close: () =>
            queueMicrotask(() => {
              events.emit("error", error);
              events.emit("close", 0, null);
            }),
        }[event as "error" | "close"];
        notify();
        return child;
      }) as OpenShellCommandChild["once"],
    };
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      spawnChild: () => child,
    });

    const completed = await executor.runStreaming({
      sandboxName: "alpha",
      target: selectedOpenShellGateway(),
      command: ["true"],
    });

    expect(completed.outcome).toEqual({
      kind: "failed",
      error: { kind, message: "child process failed" },
    });
    completed.release();
  });

  it.each([
    [0, "present"],
    [1, "missing"],
    [2, "unobservable"],
    [null, "unobservable"],
  ] as const)("maps directory probe status %s to %s", async (status, state) => {
    const spawnProbe = vi.fn(() => ({ status }));
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      spawnProbe,
    });

    expect(
      await executor.probeDirectory({
        sandboxName: "alpha",
        target: namedOpenShellGateway("nemoclaw-8091"),
        path: "/sandbox/work",
      }),
    ).toMatchObject({ state });
    expect(spawnProbe).toHaveBeenCalledWith("/usr/bin/openshell", [
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8091",
      "--",
      "test",
      "-d",
      "/sandbox/work",
    ]);
  });

  it("holds TERM handlers until command-dependent cleanup releases the stream", async () => {
    const childEvents = new EventEmitter();
    const signalEvents = new EventEmitter();
    const child: OpenShellCommandChild = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn((signal) => {
        child.signalCode = signal;
        queueMicrotask(() => childEvents.emit("close", null, signal));
        return true;
      }),
      once: ((event: string, listener: (...args: unknown[]) => void) =>
        childEvents.once(event, listener)) as OpenShellCommandChild["once"],
    };
    const signalSource: OpenShellCommandSignalSource = {
      add: (signal, listener) => signalEvents.on(signal, listener),
      remove: (signal, listener) => signalEvents.off(signal, listener),
    };
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      spawnChild: () => child,
      signalSource,
    });

    const pending = executor.runStreaming({
      sandboxName: "alpha",
      target: selectedOpenShellGateway(),
      command: ["sleep", "30"],
    });
    signalEvents.emit("SIGTERM");
    const completed = await pending;

    expect(completed.outcome).toEqual({
      kind: "completed",
      exitCode: 143,
      signal: "SIGTERM",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(signalEvents.listenerCount("SIGTERM")).toBe(1);
    completed.release();
    expect(signalEvents.listenerCount("SIGTERM")).toBe(0);
    expect(signalEvents.listenerCount("SIGINT")).toBe(0);
  });

  it("rejects endpoint overrides before resolving or spawning", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://sibling.invalid");
    const resolveBinary = vi.fn(() => "/usr/bin/openshell");
    const spawnChild = vi.fn();
    const executor = createCliOpenShellSandboxCommandExecutor({ resolveBinary, spawnChild });

    await expect(
      executor.runStreaming({
        sandboxName: "alpha",
        target: namedOpenShellGateway("nemoclaw-8091"),
        command: ["true"],
      }),
    ).rejects.toThrow("OPENSHELL_GATEWAY_ENDPOINT is set");
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(spawnChild).not.toHaveBeenCalled();
  });
});
