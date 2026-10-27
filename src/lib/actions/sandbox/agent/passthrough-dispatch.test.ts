// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { StdioOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { CapturedProcessChild } from "../../../core/process-capture";
import type { ProcessSessionSignals } from "../../../core/process-session";
import { createCliOpenShellSandboxSessionExecutor } from "../../../adapters/openshell/sandbox-command-cli";
import type { OpenShellSandboxSessionRequest } from "../../../adapters/openshell/sandbox-session";
import {
  AGENT_STDIN_MAX_BYTES,
  dispatchWithAgentStdinDeadline,
  readAgentStdinWithinDeadline,
  runAgentDispatch,
  canCloseAgentStdin,
  hasOpenClawAgentSelector,
  requestsOpenClawJsonOutput,
  AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS,
  agentDispatchDeadlineSeconds,
  replaceRequestedAgentTimeoutSeconds,
  requestedAgentTimeoutSeconds,
  runOpenClawAgentDispatch,
  isSilentAgentDispatch,
  isTimedOutAgentDispatch,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
  TIMED_OUT_AGENT_TURN_EXIT_CODE,
} from "./passthrough-dispatch";

describe("isSilentAgentDispatch", () => {
  it("classifies a zero-exit dispatch with no bytes on either stream as silent", () => {
    expect(isSilentAgentDispatch({ outcome: { kind: "exited", exitCode: 0 } }, "", "")).toBe(true);
  });

  it("does not classify a dispatch that wrote to stdout", () => {
    expect(isSilentAgentDispatch({ outcome: { kind: "exited", exitCode: 0 } }, "PONG\n", "")).toBe(
      false,
    );
  });

  it("does not classify a dispatch that wrote only to stderr", () => {
    expect(
      isSilentAgentDispatch({ outcome: { kind: "exited", exitCode: 0 } }, "", "openclaw warning\n"),
    ).toBe(false);
  });

  it("does not classify a non-zero dispatch, which already fails on its own", () => {
    expect(isSilentAgentDispatch({ outcome: { kind: "exited", exitCode: 7 } }, "", "")).toBe(false);
  });

  it("does not classify a transport error, which reports its own diagnosis", () => {
    expect(
      isSilentAgentDispatch(
        { outcome: { kind: "failed", reason: "unavailable", message: "ENOENT", exitCode: 1 } },
        "",
        "",
      ),
    ).toBe(false);
  });

  it("does not classify a signal-killed dispatch with a null status", () => {
    expect(
      isSilentAgentDispatch(
        { outcome: { kind: "signalled", signal: "SIGTERM", exitCode: 143 } },
        "",
        "",
      ),
    ).toBe(false);
  });
});

describe("canCloseAgentStdin", () => {
  it.each([
    ["--agent", "main", "-m", "ping"],
    ["--json", "--agent=main", "--message", "ping"],
    ["--deliver", "--session-key", "main", "--message=ping"],
    ["--timeout", "30", "-mping"],
    ["-m", "--json"],
    ["--message="],
    ["--message"],
    ["--message-file"],
    ["--message-file="],
    ["--message-file", " "],
    ["--message-file", "/dev/stdin", "-m", "conflicting message"],
    ["--verbose", "off", "--channel", "slack", "-m", "ping"],
    ["--local", "--reply-to", "#reports", "--reply-account", "work", "-m", "ping"],
    ["-aops", "--json", "-mping"],
    ["--profile", "work", "--log-level=debug", "--no-color", "-m", "ping"],
    ["--dev", "--container", "agent-tools", "--message", "ping"],
  ])("recognizes explicit message options %j", (...args) => {
    expect(canCloseAgentStdin(["openclaw", "agent", ...args])).toBe(true);
  });

  it.each([
    ["--agent", "main"],
    ["--agent", "--message", "ping"],
    ["--", "-m", "ping"],
    ["--unknown", "-m", "ping"],
    ["--reply-to", "-m", "payload"],
    ["-t+15555550123", "--message-file=/sandbox/task.md"],
    ["--verbose=on", "--channel=slack", "--message-file", "/sandbox/task.md"],
    ["--message-file", "/dev/stdin", "--message-file=/sandbox/task.md"],
    ["--message-file", "/dev/stdin"],
    ["--message-file", "/sandbox/message-alias"],
    ["--message-file", "relative-message-path"],
    ["--message-file=/dev/fd/0"],
    ["--message-file", " /proc/self/fd/0 "],
    ["--message-file", "/proc/thread-self/fd/0"],
    ["--message-file", "/dev/./stdin"],
    ["--message-file", "/sandbox/task.md", "--message-file=/dev/stdin"],
  ])("preserves stdin when argv does not establish a message %j", (...args) => {
    expect(canCloseAgentStdin(["openclaw", "agent", ...args])).toBe(false);
  });

  it("leaves another agent's stdin unchanged", () => {
    expect(canCloseAgentStdin(["dcode", "-m", "ping"])).toBe(false);
  });
});

describe("SILENT_AGENT_DISPATCH_EXIT_CODE", () => {
  it("reports a dispatch failure rather than success", () => {
    expect(SILENT_AGENT_DISPATCH_EXIT_CODE).toBe(1);
  });
});

describe("requestedAgentTimeoutSeconds", () => {
  const agent = (...args: string[]) => ["openclaw", "agent", ...args];

  it("uses and updates the last timeout without changing earlier argv (#11371)", () => {
    const command = agent("--timeout", "30", "--verbose", "off", "--timeout=90", "-m", "ping");
    expect(requestedAgentTimeoutSeconds(command)).toBe(90);
    expect(replaceRequestedAgentTimeoutSeconds(command, 45)).toEqual(
      agent("--timeout", "30", "--verbose", "off", "--timeout=45", "-m", "ping"),
    );
    expect(
      agentDispatchDeadlineSeconds(agent("--timeout", "30", "--timeout", "0")),
    ).toBeUndefined();
  });

  it.each([
    ["--verbose", "off"],
    ["--channel", "slack"],
    ["--reply-to", "#reports"],
    ["--reply-account", "work"],
    ["--local"],
    ["--message-file", "/sandbox/task.md"],
    ["-t+15555550123"],
    ["-mping"],
    ["--profile", "work", "--log-level", "debug", "--no-color"],
  ])("preserves the deadline after agent options %j (#11371)", (...prefix) => {
    const command = agent(...prefix, "--timeout=30");
    expect(requestedAgentTimeoutSeconds(command)).toBe(30);
    expect(replaceRequestedAgentTimeoutSeconds(command, 12)).toEqual(
      agent(...prefix, "--timeout=12"),
    );
  });

  it("rejects timeout flags outside the exact OpenClaw agent prefix (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(["other", "agent", "--timeout", "30"])).toBeNull();
    expect(requestedAgentTimeoutSeconds(["openclaw", "exec", "--timeout", "30"])).toBeNull();
  });

  it("reads a separated --timeout value (#8723)", () => {
    const command = agent("--agent", "main", "--timeout", "30");
    expect(requestedAgentTimeoutSeconds(command)).toBe(30);
    expect(replaceRequestedAgentTimeoutSeconds(command, 20)).toEqual(
      agent("--agent", "main", "--timeout", "20"),
    );
  });

  it("reads an equals-form --timeout value (#8723)", () => {
    const command = agent("--timeout=45", "-m", "hi");
    expect(requestedAgentTimeoutSeconds(command)).toBe(45);
    expect(replaceRequestedAgentTimeoutSeconds(command, 20)).toEqual(
      agent("--timeout=20", "-m", "hi"),
    );
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

describe("shared agent option interpretation", () => {
  it.each([["-t", "+15555550123"], ["-t+15555550123"], ["--agent=main"]])(
    "recognizes the target selector %j",
    (...args) => {
      expect(hasOpenClawAgentSelector(["openclaw", "agent", ...args, "-m", "ping"])).toBe(true);
    },
  );

  it.each(["--agent", "--to", "--session-key", "--session-id"])(
    "does not treat the message value %s as a selector",
    (value) => {
      expect(hasOpenClawAgentSelector(["openclaw", "agent", "-m", value])).toBe(false);
    },
  );

  it("honors the last JSON switch", () => {
    expect(requestsOpenClawJsonOutput(["openclaw", "agent", "--json", "--json=false"])).toBe(false);
    expect(requestsOpenClawJsonOutput(["openclaw", "agent", "--json=false", "--json"])).toBe(true);
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

describe("agent dispatch execution deadline", () => {
  it("delivers a turn timeout reported 20.8 seconds after its requested deadline (#8723)", async () => {
    vi.useFakeTimers();
    const harness = dispatchHarness();
    const requestedDeadlineSeconds = 30;
    const delayedFinishMilliseconds = (requestedDeadlineSeconds + 20.8) * 1000;
    const timeoutReport = "Request timed out before a response was generated.\n";
    const command = [
      "openclaw",
      "agent",
      "--timeout",
      String(requestedDeadlineSeconds),
      "-m",
      "ping",
    ];

    try {
      const pending = runOpenClawAgentDispatch("alpha", command, {
        getGatewayName: () => "test-gateway",
        runDispatch: (request) =>
          runAgentDispatch(
            request,
            createCliOpenShellSandboxSessionExecutor({
              resolveBinary: () => "openshell",
              stdinIsTty: () => true,
              signalSource: harness.signalSource,
              spawnChild: (_binary, spawnArgs) => {
                const sessionArgs = spawnArgs.slice(0, spawnArgs.indexOf("--"));
                const hostTimeoutIndex = sessionArgs.indexOf("--timeout");
                const hostTimeoutMilliseconds = Number(sessionArgs[hostTimeoutIndex + 1]) * 1000;
                setTimeout(() => harness.child.kill("SIGTERM"), hostTimeoutMilliseconds);
                setTimeout(() => {
                  harness.stdout.emit("data", timeoutReport);
                  harness.child.exitCode = 0;
                  harness.childEvents.emit("close", 0, null);
                }, delayedFinishMilliseconds);
                return harness.child;
              },
            }),
          ),
      });

      await vi.advanceTimersByTimeAsync(delayedFinishMilliseconds);
      expect(await pending).toMatchObject({
        outcome: { kind: "exited", exitCode: 0 },
        stdout: timeoutReport,
        stderr: "",
      });
      expect(harness.child.kill).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("agent piped-input deadline (#13621)", () => {
  const request: OpenShellSandboxSessionRequest = {
    kind: "command",
    sandboxName: "alpha",
    target: { kind: "selected" },
    command: ["openclaw", "agent", "--agent", "main"],
    tty: false,
    output: "capture",
  };
  const delivered = {
    outcome: { kind: "exited" as const, exitCode: 0 },
    stdout: "PONG\n",
    stderr: "",
  };
  const runner = () => vi.fn(async (_request: OpenShellSandboxSessionRequest) => delivered);

  it("hands piped input that reached EOF to OpenShell", async () => {
    const run = runner();
    const readStdin = vi.fn(async () => ({ kind: "eof" as const, data: Buffer.from("ping\n") }));

    const result = await dispatchWithAgentStdinDeadline(request, 30, run, {
      stdinIsTty: () => false,
      readStdin,
    });

    expect(result).toEqual(delivered);
    expect(readStdin).toHaveBeenCalledWith(30_000);
    expect(run).toHaveBeenCalledWith({ ...request, stdin: Buffer.from("ping\n") });
  });

  it.each([
    [
      { kind: "deadline" as const },
      "Timed out after 1 second(s) waiting for the piped message to end.",
    ],
    [{ kind: "too-large" as const }, `The piped message exceeds ${AGENT_STDIN_MAX_BYTES} bytes.`],
    [{ kind: "read-error" as const }, "Could not read the piped message from stdin."],
  ])("fails before dispatch when piped input does not end cleanly %#", async (read, problem) => {
    const run = runner();

    const result = await dispatchWithAgentStdinDeadline(request, 1, run, {
      stdinIsTty: () => false,
      readStdin: async () => read,
    });

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: { kind: "exited", exitCode: 1 }, stdout: "" });
    expect(result.stderr).toContain(problem);
    expect(result.stderr).toContain("provide --message, or set --timeout <seconds>");
  });

  it.each([
    ["closed stdin", { ...request, stdin: false }, false],
    ["interactive terminal", request, true],
  ])("keeps the %s posture without reading input", async (_name, prepared, terminal) => {
    const run = runner();
    const readStdin = vi.fn();

    await dispatchWithAgentStdinDeadline(prepared as OpenShellSandboxSessionRequest, 30, run, {
      stdinIsTty: () => terminal,
      readStdin,
    });

    expect(readStdin).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(prepared);
  });

  it.each([
    [["--timeout", "1"], 1_000],
    [[], 30_000],
    [["--timeout", "1.5"], 30_000],
    [["--unknown-flag", "--timeout", "1"], 30_000],
    [["--", "--timeout", "1"], 30_000],
    [["--timeout", String(Number.MAX_SAFE_INTEGER)], 30_000],
  ])(
    "uses a recognized --timeout, else 30 seconds, as the input deadline %#",
    async (flags, ms) => {
      const readStdin = vi.fn(async () => ({ kind: "deadline" as const }));

      const result = await runOpenClawAgentDispatch(
        "alpha",
        ["openclaw", "agent", "--agent", "main", ...flags],
        { getGatewayName: () => null, stdinIsTty: () => false, readStdin },
      );

      expect(readStdin).toHaveBeenCalledWith(ms);
      expect(result.outcome).toEqual({ kind: "exited", exitCode: 1 });
    },
  );

  it("hands EOF-delimited input from the default dispatch to OpenShell fd 0", async () => {
    const harness = dispatchHarness();
    const end = vi.fn();
    harness.child.stdin = { on: vi.fn(), end };
    const spawnChild = vi.fn(
      (_binary: string, _args: readonly string[], _options: { stdio: StdioOptions }) => {
        queueMicrotask(() => {
          harness.stdout.emit("data", "PONG\n");
          harness.child.exitCode = 0;
          harness.childEvents.emit("close", 0, null);
        });
        return harness.child;
      },
    );

    const result = await runOpenClawAgentDispatch(
      "alpha",
      ["openclaw", "agent", "--agent", "main"],
      {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        stdinIsTty: () => false,
        readStdin: async () => ({ kind: "eof", data: Buffer.from("ping\n") }),
        spawnChild,
      },
    );

    expect(spawnChild.mock.calls[0]?.[2].stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(end).toHaveBeenCalledWith(Buffer.from("ping\n"));
    expect(result).toMatchObject({ outcome: { kind: "exited", exitCode: 0 }, stdout: "PONG\n" });
  });

  it("reads piped input to EOF", async () => {
    const source = new PassThrough();
    const pending = readAgentStdinWithinDeadline(source, 1_000);

    source.end("ping\n");

    await expect(pending).resolves.toEqual({ kind: "eof", data: Buffer.from("ping\n") });
  });

  it("stops at the deadline while the producer keeps the pipe open", async () => {
    vi.useFakeTimers();
    try {
      const source = new PassThrough();
      const pending = readAgentStdinWithinDeadline(source, 1_000);
      source.write("ping\n");

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({ kind: "deadline" });
      expect(source.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a read error after partial input instead of a truncated message", async () => {
    const source = new PassThrough();
    const pending = readAgentStdinWithinDeadline(source, 1_000);

    source.write("pi");
    source.destroy(new Error("EIO"));

    await expect(pending).resolves.toEqual({ kind: "read-error" });
  });

  it("stops at the size limit", async () => {
    const source = new PassThrough();
    const pending = readAgentStdinWithinDeadline(source, 1_000, 4);

    source.write("12345");

    await expect(pending).resolves.toEqual({ kind: "too-large" });
    expect(source.destroyed).toBe(true);
  });
});
