// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  type AgentDispatchChild,
  AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS,
  agentDispatchDeadlineSeconds,
  agentDispatchStdio,
  isSilentAgentDispatch,
  isTimedOutAgentDispatch,
  requestedAgentTimeoutSeconds,
  runAgentDispatch,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
  TIMED_OUT_AGENT_TURN_EXIT_CODE,
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

describe("requestedAgentTimeoutSeconds", () => {
  const agent = (...args: string[]) => ["openclaw", "agent", ...args];

  it("rejects timeout flags outside the exact OpenClaw agent prefix (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(["other", "agent", "--timeout", "30"])).toBeNull();
    expect(requestedAgentTimeoutSeconds(["openclaw", "exec", "--timeout", "30"])).toBeNull();
  });

  it("reads a separated --timeout value (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("--agent", "main", "--timeout", "30"))).toBe(30);
  });

  it("reads an equals-form --timeout value (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("--timeout=45", "-m", "hi"))).toBe(45);
  });

  it("reads a timeout after documented boolean and equals-form options (#8723)", () => {
    expect(
      requestedAgentTimeoutSeconds(
        agent("--deliver", "--agent=main", "--json=false", "--timeout", "30"),
      ),
    ).toBe(30);
  });

  it("requests no deadline when the argv carries no --timeout (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("--agent", "main", "-m", "hi"))).toBeNull();
  });

  it("returns null for --timeout 0 so the host stays unbounded (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("--timeout", "0"))).toBeNull();
  });

  it("ignores a --timeout consumed as another option's value (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("-m", "--timeout", "--agent", "main"))).toBeNull();
  });

  it("ignores anything past the -- terminator (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("--", "--timeout", "30"))).toBeNull();
  });

  it("keeps the host unbounded after an unknown option (#8723)", () => {
    const argv = agent("--unknown", "--timeout", "30");
    expect(requestedAgentTimeoutSeconds(argv)).toBeNull();
    expect(agentDispatchDeadlineSeconds(argv)).toBeUndefined();
  });

  it.each(["-5", "1.5", "abc", "", "1e3"])(
    "refuses a value that cannot be a deadline: %j (#8723)",
    (raw) => {
      expect(requestedAgentTimeoutSeconds(agent("--timeout", raw))).toBeNull();
    },
  );

  it("refuses a missing deadline value (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("--timeout"))).toBeNull();
  });
});

describe("agentDispatchDeadlineSeconds", () => {
  it("outlasts the requested deadline so the turn reports its own timeout (#8723)", () => {
    expect(agentDispatchDeadlineSeconds(["openclaw", "agent", "--timeout", "30"])).toBe(
      30 + AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS,
    );
  });

  it("leaves the transport unbounded when no deadline was requested (#8723)", () => {
    expect(agentDispatchDeadlineSeconds(["openclaw", "agent", "-m", "hi"])).toBeUndefined();
  });

  it("holds the deadline buffer above the longest aborted-run finish measured (#8723)", () => {
    expect(AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS).toBeGreaterThan(20);
  });

  it("stays unbounded when the buffered deadline leaves the safe-integer range (#8723)", () => {
    const ceiling = String(Number.MAX_SAFE_INTEGER);
    expect(requestedAgentTimeoutSeconds(["openclaw", "agent", "--timeout", ceiling])).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    // The buffer would round past the ceiling, so the argv would carry a
    // deadline that differs from the one the caller asked for.
    expect(
      agentDispatchDeadlineSeconds(["openclaw", "agent", "--timeout", ceiling]),
    ).toBeUndefined();
  });

  it("still bounds the largest deadline that survives the buffer (#8723)", () => {
    const largest = String(Number.MAX_SAFE_INTEGER - AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS);
    expect(agentDispatchDeadlineSeconds(["openclaw", "agent", "--timeout", largest])).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("isTimedOutAgentDispatch", () => {
  const timeoutReport =
    "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";

  it("classifies the timeout report OpenClaw writes to stdout (#8723)", () => {
    expect(isTimedOutAgentDispatch(`${timeoutReport}\n`, "")).toBe(true);
  });

  it("classifies a timeout report that arrives below tool-failure lines (#8723)", () => {
    const captured = `LLM request failed.\nTool Call failed\n${timeoutReport}\n`;
    expect(isTimedOutAgentDispatch(captured, "")).toBe(true);
  });

  it("classifies a timeout report routed to stderr instead (#8723)", () => {
    expect(isTimedOutAgentDispatch("", `${timeoutReport}\n`)).toBe(true);
  });

  it("keeps classifying when the configuration advice is reworded upstream (#8723)", () => {
    const reworded = "Request timed out before a response was generated. Raise the deadline.";
    expect(isTimedOutAgentDispatch(reworded, "")).toBe(true);
  });

  it("leaves an ordinary answer unclassified (#8723)", () => {
    expect(isTimedOutAgentDispatch("PONG\n", "openclaw warning\n")).toBe(false);
  });

  it("leaves an unrelated timed-out message unclassified (#8723)", () => {
    const mcpFailure = "McpError: MCP error -32001: Request timed out\n";
    expect(isTimedOutAgentDispatch(mcpFailure, "")).toBe(false);
  });
});

describe("TIMED_OUT_AGENT_TURN_EXIT_CODE", () => {
  it("reports a turn failure rather than success (#8723)", () => {
    expect(TIMED_OUT_AGENT_TURN_EXIT_CODE).toBe(1);
  });
});
