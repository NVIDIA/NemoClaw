// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS,
  agentDispatchDeadlineSeconds,
  isSilentAgentDispatch,
  isTimedOutAgentDispatch,
  replaceRequestedAgentTimeoutSeconds,
  requestedAgentTimeoutSeconds,
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
