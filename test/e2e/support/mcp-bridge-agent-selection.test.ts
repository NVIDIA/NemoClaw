// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  MCP_BRIDGE_E2E_SCOPES,
  MCP_BRIDGE_SHARDS,
  resolveMcpBridgeE2eScope,
  resolveMcpBridgeShard,
  runFullMcpBridgeE2eCoverage,
} from "../live/mcp-bridge-agent-selection.ts";

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

describe("MCP bridge E2E scope", () => {
  it("keeps ordinary live runs on full coverage", () => {
    expect(resolveMcpBridgeE2eScope(undefined)).toBe("full");
  });

  it.each(MCP_BRIDGE_E2E_SCOPES)("accepts the reviewed %s scope", (scope) => {
    expect(resolveMcpBridgeE2eScope(scope)).toBe(scope);
  });

  it("fails closed for an unreviewed scope", () => {
    expect(() => resolveMcpBridgeE2eScope("skip-trusted-private")).toThrow(
      "Unsupported NEMOCLAW_MCP_BRIDGE_E2E_SCOPE: skip-trusted-private",
    );
  });

  it("runs trusted-private coverage for the full scope", async () => {
    const operation = vi.fn().mockResolvedValue("complete");

    await expect(runFullMcpBridgeE2eCoverage("full", operation)).resolves.toBe("complete");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("omits trusted-private coverage from managed-image discovery", async () => {
    const operation = vi.fn().mockResolvedValue("unexpected");

    await expect(
      runFullMcpBridgeE2eCoverage("managed-image-discovery", operation),
    ).resolves.toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
  });
});
