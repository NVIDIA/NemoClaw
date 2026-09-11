// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  runCapturedProcess,
  capturedProcessStdio,
  type CapturedProcessChild,
} from "./process-capture";
import type { ProcessSessionSignals } from "./process-session";

function dispatchHarness() {
  const childEvents = new EventEmitter();
  const signalEvents = new EventEmitter();
  const stderr = new EventEmitter();
  const stdout = new EventEmitter();
  const child: CapturedProcessChild = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal) => {
      child.signalCode = signal;
      queueMicrotask(() => childEvents.emit("close", null, signal));
      return true;
    }),
    once: ((event: string, listener: (...args: unknown[]) => void) =>
      childEvents.once(event, listener)) as CapturedProcessChild["once"],
    stderr,
    stdout,
  };
  const signalSource: ProcessSessionSignals = {
    add: (signal, listener) => signalEvents.on(signal, listener),
    remove: (signal, listener) => signalEvents.off(signal, listener),
  };
  return { child, childEvents, signalEvents, signalSource, stderr, stdout };
}

describe("runCapturedProcess", () => {
  it("forwards host SIGTERM to OpenShell and captures output before signal exit (#8723)", async () => {
    const harness = dispatchHarness();
    const pending = runCapturedProcess(
      "openshell",
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "agent"],
      { stdinIsTty: true },
      { signalSource: harness.signalSource, spawnChild: () => harness.child },
    );

    harness.stdout.emit("data", "partial response\n");
    harness.stderr.emit("data", Buffer.from("gateway timeout pending\n"));
    harness.signalEvents.emit("SIGTERM");

    const result = await pending;
    expect(harness.child.kill).toHaveBeenCalledOnce();
    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result).toMatchObject({
      status: null,
      signal: "SIGTERM",
      stdout: "partial response\n",
      stderr: "gateway timeout pending\n",
    });
    expect(harness.signalEvents.listenerCount("SIGTERM")).toBe(0);
    expect(harness.signalEvents.listenerCount("SIGINT")).toBe(0);
  });

  it("terminates the OpenShell child when captured output exceeds its bound", async () => {
    const harness = dispatchHarness();
    const pending = runCapturedProcess(
      "openshell",
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "agent"],
      { maxBufferBytes: 4, stdinIsTty: false },
      { signalSource: harness.signalSource, spawnChild: () => harness.child },
    );

    harness.stdout.emit("data", "12345");

    const result = await pending;
    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.error?.message).toBe("agent output exceeded the 4-byte combined capture limit");
    expect(result.error).toHaveProperty("code", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(result.stdout).toBe("");
  });

  it("enforces one capture bound across stdout and stderr", async () => {
    const harness = dispatchHarness();
    const pending = runCapturedProcess(
      "openshell",
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "agent"],
      { maxBufferBytes: 6, stdinIsTty: false },
      { signalSource: harness.signalSource, spawnChild: () => harness.child },
    );

    harness.stdout.emit("data", "1234");
    harness.stderr.emit("data", "567");

    const result = await pending;
    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.error?.message).toBe("agent output exceeded the 6-byte combined capture limit");
    expect(result.stdout).toBe("1234");
    expect(result.stderr).toBe("");
  });
});
describe("capturedProcessStdio", () => {
  it("withholds an interactive terminal from fd 0", () => {
    expect(capturedProcessStdio(true)).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("forwards a non-terminal stdin so scripted input keeps working", () => {
    expect(capturedProcessStdio(false)).toEqual(["inherit", "pipe", "pipe"]);
  });

  it("captures both output streams in either stdin posture", () => {
    expect([capturedProcessStdio(true).slice(1), capturedProcessStdio(false).slice(1)]).toEqual([
      ["pipe", "pipe"],
      ["pipe", "pipe"],
    ]);
  });
});
