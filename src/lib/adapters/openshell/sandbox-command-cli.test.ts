// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCliOpenShellSandboxExecArgs,
  createCliOpenShellSandboxCommandExecutor,
  createCurrentnessBoundCliOpenShellSandboxBufferedCommandExecutor,
  runCliOpenShellBufferedCommand,
  type OpenShellBufferedCommandRunner,
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

function killTestProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Expected when the command runner already terminated the process group.
  }
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

  it("captures a buffered command with explicit target, environment, input, and limits", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>(async () => ({
      status: 42,
      signal: null,
      stdout: "output\n",
      stderr: "warning\n",
    }));
    const hostEnvironment = { PATH: "/trusted/bin", OPENSHELL_GATEWAY: "nemoclaw-8091" };
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered,
      hostCwd: "/repo",
    });

    const completed = await executor.runBuffered({
      sandboxName: "alpha",
      target: namedOpenShellGateway("nemoclaw-8091"),
      command: ["sh", "-c", "read line; printf '%s' \"$line\""],
      environment: hostEnvironment,
      sandboxEnvironment: { HOME: "/usr/local/lib/nemoclaw", BASH_ENV: "", ENV: "" },
      input: "hello\n",
      tty: false,
      workdir: "/sandbox/work",
      timeoutMilliseconds: 9000,
      outputLimitBytes: 2048,
    });

    expect(completed).toEqual({
      outcome: { kind: "completed", exitCode: 42 },
      stdout: "output\n",
      stderr: "warning\n",
    });
    expect(runBuffered).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      [
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "-g",
        "nemoclaw-8091",
        "--workdir",
        "/sandbox/work",
        "--no-tty",
        "--env",
        "BASH_ENV=",
        "--env",
        "ENV=",
        "--env",
        "HOME=/usr/local/lib/nemoclaw",
        "--",
        "sh",
        "-c",
        "read line; printf '%s' \"$line\"",
      ],
      {
        environment: hostEnvironment,
        hostCwd: "/repo",
        input: "hello\n",
        timeoutMilliseconds: 9000,
        outputLimitBytes: 2048,
      },
    );
  });

  it("binds buffered execution to retained binary, environment, and currentness", async () => {
    const events: string[] = [];
    let release!: () => void;
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>(async (binary, _args, options) => {
      events.push(`run:${binary}:${options.environment?.OPENSHELL_GATEWAY ?? "missing"}`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 0, stdout: "ok", stderr: "" };
    });
    const assertCurrent = vi.fn(() => events.push("current"));
    const executor = createCurrentnessBoundCliOpenShellSandboxBufferedCommandExecutor(
      {
        resolveBinary: () => "/retained/openshell",
        hostCwd: "/repo",
        hostEnv: { PATH: "/retained/bin", OPENSHELL_GATEWAY: "receipt-owned" },
        runBuffered,
      },
      assertCurrent,
    );

    const pending = executor.runBuffered({
      sandboxName: "alpha",
      target: namedOpenShellGateway("receipt-owned"),
      command: ["true"],
    });
    expect(events).toEqual(["current", "run:/retained/openshell:receipt-owned"]);
    release();
    await expect(pending).resolves.toMatchObject({ stdout: "ok" });
    expect(events).toEqual(["current", "run:/retained/openshell:receipt-owned", "current"]);
    expect(runBuffered).toHaveBeenCalledWith(
      "/retained/openshell",
      expect.any(Array),
      expect.objectContaining({
        environment: { PATH: "/retained/bin", OPENSHELL_GATEWAY: "receipt-owned" },
        hostCwd: "/repo",
      }),
    );
  });

  it("closes buffered stdin when no input is provided", async () => {
    const result = await runCliOpenShellBufferedCommand(
      process.execPath,
      ["-e", "process.stdin.on('end', () => process.stdout.write('EOF')); process.stdin.resume();"],
      { timeoutMilliseconds: 1000 },
    );

    expect(result).toMatchObject({ status: 0, stdout: "EOF" });
    expect(result.timedOut).toBeUndefined();
  });

  it("delivers nonempty buffered stdin exactly", async () => {
    const input = "first line\nsecond line\n";
    const result = await runCliOpenShellBufferedCommand(
      process.execPath,
      [
        "-e",
        "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(input));",
      ],
      { input, timeoutMilliseconds: 1000 },
    );

    expect(result).toMatchObject({ status: 0, stdout: input, stderr: "" });
    expect(result.error).toBeUndefined();
  });

  it.each([
    ["stdout", "process.stdout.write('x'.repeat(64))"],
    ["stderr", "process.stderr.write('x'.repeat(64))"],
  ] as const)("bounds real buffered %s capture", async (stream, script) => {
    const result = await runCliOpenShellBufferedCommand(process.execPath, ["-e", script], {
      outputLimitBytes: 8,
      timeoutMilliseconds: 1000,
    });

    expect(result.status).toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    );
    expect(Buffer.byteLength(result[stream])).toBe(8);
  });

  it.runIf(process.platform !== "win32")(
    "forwards host cancellation to the buffered process group and releases handlers",
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buffered-cancel-"));
      const pidPath = path.join(directory, "descendant.pid");
      const survivorPath = path.join(directory, "descendant-survived");
      const signalEvents = new EventEmitter();
      const signalSource: OpenShellCommandSignalSource = {
        add: (signal, listener) => signalEvents.on(signal, listener),
        remove: (signal, listener) => signalEvents.off(signal, listener),
      };
      let descendantPid: number | undefined;
      try {
        const descendantScript = [
          "const fs = require('node:fs');",
          "process.on('SIGINT', () => {});",
          `setTimeout(() => fs.writeFileSync(${JSON.stringify(survivorPath)}, 'alive'), 500);`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
          "process.on('SIGINT', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");
        const pending = runCliOpenShellBufferedCommand(process.execPath, ["-e", parentScript], {
          signalSource,
          timeoutMilliseconds: 3000,
        });
        await vi.waitFor(() => expect(fs.existsSync(pidPath)).toBe(true));
        signalEvents.emit("SIGINT");
        const result = await pending;

        descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
        expect(result).toMatchObject({ status: null, signal: "SIGINT" });
        expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ECANCELED");
        expect(signalEvents.listenerCount("SIGTERM")).toBe(0);
        expect(signalEvents.listenerCount("SIGINT")).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(fs.existsSync(survivorPath)).toBe(false);
      } finally {
        descendantPid === undefined || killTestProcess(descendantPid);
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("marks only its own buffered deadline as a timeout", async () => {
    const result = await runCliOpenShellBufferedCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMilliseconds: 10 },
    );

    expect(result).toMatchObject({ status: null, signal: "SIGTERM", timedOut: true });
  });

  it("keeps the timeout classification when SIGTERM triggers a clean exit", async () => {
    const result = await runCliOpenShellBufferedCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
      { timeoutMilliseconds: 50 },
    );

    expect(result).toMatchObject({ status: null, signal: "SIGTERM", timedOut: true });
  });

  it("escalates a buffered timeout when the child ignores SIGTERM", async () => {
    const result = await runCliOpenShellBufferedCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMilliseconds: 200 },
    );

    expect(result).toMatchObject({ status: null, signal: "SIGKILL", timedOut: true });
  });

  it("supports immediate process-group SIGKILL for deadline-bounded probes", async () => {
    const result = await runCliOpenShellBufferedCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMilliseconds: 200, timeoutKillSignal: "SIGKILL" },
    );

    expect(result).toMatchObject({ status: null, signal: "SIGKILL", timedOut: true });
  });

  it.runIf(process.platform !== "win32")(
    "terminates descendants when the direct buffered child exits cleanly on timeout",
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buffered-tree-"));
      const pidPath = path.join(directory, "descendant.pid");
      const survivorPath = path.join(directory, "descendant-survived");
      let descendantPid: number | undefined;
      try {
        const descendantScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          `setTimeout(() => fs.writeFileSync(${JSON.stringify(survivorPath)}, 'alive'), 500);`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");

        const result = await runCliOpenShellBufferedCommand(
          process.execPath,
          ["-e", parentScript],
          {
            timeoutMilliseconds: 250,
          },
        );

        descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
        expect(result).toMatchObject({ status: null, signal: "SIGTERM", timedOut: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(fs.existsSync(survivorPath)).toBe(false);
      } finally {
        descendantPid === undefined || killTestProcess(descendantPid);
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("terminates a buffered child that closes stdin early but remains alive", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buffered-epipe-"));
    const pidPath = path.join(directory, "child.pid");
    const survivorPath = path.join(directory, "child-survived");
    let childPid: number | undefined;
    try {
      const script = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "fs.closeSync(0);",
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(survivorPath)}, 'alive'), 500);`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const result = await runCliOpenShellBufferedCommand(process.execPath, ["-e", script], {
        input: "x".repeat(10 * 1024 * 1024),
        timeoutMilliseconds: 3000,
      });

      childPid = Number(fs.readFileSync(pidPath, "utf8"));
      expect(result.status).toBeNull();
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("EPIPE");
      expect(result.timedOut).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(survivorPath)).toBe(false);
    } finally {
      childPid === undefined || killTestProcess(childPid);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves an explicit child signal when a later timeout was configured", async () => {
    const result = await runCliOpenShellBufferedCommand(
      process.execPath,
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      { timeoutMilliseconds: 1000 },
    );

    expect(result).toMatchObject({ status: null, signal: "SIGTERM" });
    expect(result.timedOut).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("uses a sanitized host environment when none is supplied", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "must-not-leak");
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>(async () => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered,
    });

    await executor.runBuffered({
      sandboxName: "alpha",
      target: selectedOpenShellGateway(),
      command: ["true"],
    });

    const options = runBuffered.mock.calls[0]?.[2];
    expect(options?.environment).toBeDefined();
    expect(options?.environment).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
  });

  it.each([
    ["an unavailable executable", "ENOENT", "unavailable"],
    ["a capture limit", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "capture"],
    ["an unclassified transport failure", undefined, "invocation"],
  ] as const)("maps %s for buffered execution", async (_label, code, kind) => {
    const error = Object.assign(new Error("buffered command failed"), code ? { code } : {});
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered: async () => ({ status: null, stdout: "partial", stderr: "detail", error }),
    });

    await expect(
      executor.runBuffered({
        sandboxName: "alpha",
        target: selectedOpenShellGateway(),
        command: ["true"],
      }),
    ).resolves.toEqual({
      outcome: { kind: "failed", error: { kind, message: "buffered command failed" } },
      stdout: "partial",
      stderr: "detail",
    });
  });

  it("maps a real buffered spawn failure to unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-missing-openshell-"));
    try {
      const executor = createCliOpenShellSandboxCommandExecutor({
        resolveBinary: () => path.join(dir, "missing-openshell"),
      });

      await expect(
        executor.runBuffered({
          sandboxName: "alpha",
          target: selectedOpenShellGateway(),
          command: ["true"],
        }),
      ).resolves.toEqual({
        outcome: {
          kind: "failed",
          error: { kind: "unavailable", message: expect.stringContaining("ENOENT") },
        },
        stdout: "",
        stderr: "",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps a buffered timeout without treating it as a remote exit", async () => {
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered: async () => ({
        status: null,
        signal: "SIGTERM",
        stdout: "partial",
        stderr: "",
        timedOut: true,
      }),
    });

    await expect(
      executor.runBuffered({
        sandboxName: "alpha",
        target: selectedOpenShellGateway(),
        command: ["sleep", "30"],
        timeoutMilliseconds: 10,
      }),
    ).resolves.toEqual({
      outcome: {
        kind: "failed",
        error: { kind: "timeout", message: "OpenShell command timed out" },
      },
      stdout: "partial",
      stderr: "",
    });
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

  it("rejects endpoint overrides from the buffered request environment", async () => {
    const resolveBinary = vi.fn(() => "/usr/bin/openshell");
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>();
    const executor = createCliOpenShellSandboxCommandExecutor({ resolveBinary, runBuffered });

    await expect(
      executor.runBuffered({
        sandboxName: "alpha",
        target: namedOpenShellGateway("nemoclaw-8091"),
        command: ["true"],
        environment: {
          PATH: "/usr/bin",
          OPENSHELL_GATEWAY_ENDPOINT: "https://sibling.invalid",
        },
      }),
    ).rejects.toThrow("OPENSHELL_GATEWAY_ENDPOINT is set");
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(runBuffered).not.toHaveBeenCalled();
  });
});
