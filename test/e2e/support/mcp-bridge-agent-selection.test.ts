// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MCP_BRIDGE_SHARDS, resolveMcpBridgeShard } from "../live/mcp-bridge-agent-selection.ts";

describe("MCP bridge agent selection", () => {
  it("keeps local runs on the existing OpenClaw default", () => {
    expect(resolveMcpBridgeShard(undefined)).toBe("openclaw");
  });

  it.each(MCP_BRIDGE_SHARDS)("accepts the reviewed %s shard", (shard) => {
    expect(resolveMcpBridgeShard(shard)).toBe(shard);
  });

  it("fails closed for an unreviewed shard", () => {
    expect(() => resolveMcpBridgeShard("all")).toThrow(
      "Unsupported NEMOCLAW_MCP_BRIDGE_AGENT: all",
    );
  });
});
