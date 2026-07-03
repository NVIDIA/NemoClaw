// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { prepareMcpBeforeBestEffortNimStop } from "./rebuild-mcp-order";

describe("rebuild MCP and local NIM ordering", () => {
  it("does not stop NIM when MCP preservation fails or aborts", async () => {
    const stopNim = vi.fn();
    await expect(
      prepareMcpBeforeBestEffortNimStop({
        prepareMcp: async () => null,
        stopNim,
        log: vi.fn(),
      }),
    ).resolves.toBeNull();
    expect(stopNim).not.toHaveBeenCalled();

    await expect(
      prepareMcpBeforeBestEffortNimStop({
        prepareMcp: async () => {
          throw new Error("policy drift");
        },
        stopNim,
        log: vi.fn(),
      }),
    ).rejects.toThrow("policy drift");
    expect(stopNim).not.toHaveBeenCalled();
  });

  it("stops NIM only after MCP preservation and treats stop as best effort", async () => {
    const order: string[] = [];
    const log = vi.fn();
    await expect(
      prepareMcpBeforeBestEffortNimStop({
        prepareMcp: async () => {
          order.push("mcp-prepared");
          return { entries: 1 };
        },
        stopNim: () => {
          order.push("nim-stop");
          throw new Error("runtime unavailable");
        },
        log,
      }),
    ).resolves.toEqual({ entries: 1 });
    expect(order).toEqual(["mcp-prepared", "nim-stop"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("runtime unavailable"));
  });
});
