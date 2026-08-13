// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS,
  agentDispatchDeadlineSeconds,
  agentDispatchStdio,
  isSilentAgentDispatch,
  requestedAgentTimeoutSeconds,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
} from "./passthrough-dispatch";

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

  it("reads a separated --timeout value (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("--agent", "main", "--timeout", "30"))).toBe(30);
  });

  it("reads an equals-form --timeout value (#8723)", () => {
    expect(requestedAgentTimeoutSeconds(agent("--timeout=45", "-m", "hi"))).toBe(45);
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

  it("refuses a value that cannot be a deadline (#8723)", () => {
    for (const raw of ["-5", "1.5", "abc", "", "1e3"]) {
      expect(requestedAgentTimeoutSeconds(agent("--timeout", raw))).toBeNull();
    }
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
});
