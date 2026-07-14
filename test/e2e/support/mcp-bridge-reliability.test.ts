// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isHermesRestartTransportFailure } from "../live/mcp-bridge-reliability.ts";

const HERMES_BROKEN_PIPE = `Error: code: 'Unknown error', message: "h2 protocol error: error reading a body
from connection", source: hyper::Error(Body, Error { kind: Io(Custom
{ kind: BrokenPipe, error: "stream closed because of a broken pipe" }) })`;

describe("MCP bridge transient classification", () => {
  it("accepts only the Hermes managed-restart broken-pipe signature", () => {
    expect(isHermesRestartTransportFailure("hermes-config", HERMES_BROKEN_PIPE)).toBe(true);
    expect(isHermesRestartTransportFailure("mcporter", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("deepagents-config", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "h2 protocol error")).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "stream closed: broken pipe")).toBe(
      false,
    );
  });
});
