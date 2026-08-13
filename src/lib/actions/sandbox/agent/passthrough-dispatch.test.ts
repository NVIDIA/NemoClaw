// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  agentDispatchStdio,
  isSilentAgentDispatch,
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
