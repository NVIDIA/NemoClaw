// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  type AgentDispatchChild,
  agentDispatchStdio,
  isSilentAgentDispatch,
  runAgentDispatch,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
} from "./passthrough-dispatch";
import { computeExitCode, type SandboxExecSignalSource } from "../exec";

function dispatchHarness() {
  const childEvents = new EventEmitter();
  const signalEvents = new EventEmitter();
  const stderr = new EventEmitter();
  const stdout = new EventEmitter();
  const child: AgentDispatchChild = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal) => {
      child.signalCode = signal;
      queueMicrotask(() => childEvents.emit("close", null, signal));
      return true;
    }),
    once: ((event: string, listener: (...args: unknown[]) => void) =>
      childEvents.once(event, listener)) as AgentDispatchChild["once"],
    stderr,
    stdout,
  };
  const signalSource: SandboxExecSignalSource = {
    add: (signal, listener) => signalEvents.on(signal, listener),
    remove: (signal, listener) => signalEvents.off(signal, listener),
  };
  return { child, signalEvents, signalSource, stderr, stdout };
}

describe("runAgentDispatch", () => {
  it("forwards host SIGTERM to OpenShell and captures output before signal exit (#8723)", async () => {
    const harness = dispatchHarness();
    const pending = runAgentDispatch(
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
    const pending = runAgentDispatch(
      "openshell",
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "agent"],
      { maxBufferBytes: 4, stdinIsTty: false },
      { signalSource: harness.signalSource, spawnChild: () => harness.child },
    );

    harness.stdout.emit("data", "12345");

    const result = await pending;
    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.error).toEqual(
      new Error("agent output exceeded the 4-byte combined capture limit"),
    );
    expect(computeExitCode(result)).toEqual({
      code: 1,
      errorMessage: "agent output exceeded the 4-byte combined capture limit",
    });
    expect(result.stdout).toBe("");
  });

  it("enforces one capture bound across stdout and stderr", async () => {
    const harness = dispatchHarness();
    const pending = runAgentDispatch(
      "openshell",
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "agent"],
      { maxBufferBytes: 6, stdinIsTty: false },
      { signalSource: harness.signalSource, spawnChild: () => harness.child },
    );

    harness.stdout.emit("data", "1234");
    harness.stderr.emit("data", "567");

    const result = await pending;
    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.error).toEqual(
      new Error("agent output exceeded the 6-byte combined capture limit"),
    );
    expect(result.stdout).toBe("1234");
    expect(result.stderr).toBe("");
  });
});

describe("isSilentAgentDispatch", () => {
  it("classifies a zero-exit dispatch with no bytes on either stream as silent", () => {
    expect(isSilentAgentDispatch({ status: 0 }, "", "")).toBe(true);
  });

  it("does not classify a dispatch that wrote to stdout", () => {
    expect(isSilentAgentDispatch({ status: 0 }, "PONG\n", "")).toBe(false);
  });

  it("does not classify a dispatch that wrote only to stderr", () => {
    expect(isSilentAgentDispatch({ status: 0 }, "", "openclaw warning\n")).toBe(false);
  });

  it("does not classify a non-zero dispatch, which already fails on its own", () => {
    expect(isSilentAgentDispatch({ status: 7 }, "", "")).toBe(false);
  });

  it("does not classify a transport error, which reports its own diagnosis", () => {
    expect(isSilentAgentDispatch({ status: null, error: new Error("ENOENT") }, "", "")).toBe(false);
  });

  it("does not classify a signal-killed dispatch with a null status", () => {
    expect(isSilentAgentDispatch({ status: null }, "", "")).toBe(false);
  });
});

describe("agentDispatchStdio", () => {
  it("withholds an interactive terminal from fd 0", () => {
    expect(agentDispatchStdio(true)).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("forwards a non-terminal stdin so scripted input keeps working", () => {
    expect(agentDispatchStdio(false)).toEqual(["inherit", "pipe", "pipe"]);
  });

  it("captures both output streams in either stdin posture", () => {
    expect([agentDispatchStdio(true).slice(1), agentDispatchStdio(false).slice(1)]).toEqual([
      ["pipe", "pipe"],
      ["pipe", "pipe"],
    ]);
  });
});

describe("SILENT_AGENT_DISPATCH_EXIT_CODE", () => {
  it("reports a dispatch failure rather than success", () => {
    expect(SILENT_AGENT_DISPATCH_EXIT_CODE).toBe(1);
  });
});
