// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { PUBLIC_DISPLAY_ENTRIES } from "./public-display-defaults";
import { SANDBOX_MCP_DISPLAY_LAYOUT } from "./public-display-mcp";

describe("sandbox MCP public display layout", () => {
  it("owns the complete MCP lifecycle help surface and feeds the public registry", () => {
    expect(Object.keys(SANDBOX_MCP_DISPLAY_LAYOUT)).toEqual(["sandbox:mcp"]);
    expect(SANDBOX_MCP_DISPLAY_LAYOUT["sandbox:mcp"]?.map((entry) => entry.usage)).toEqual([
      "nemoclaw <name> mcp list",
      "nemoclaw <name> mcp add",
      "nemoclaw <name> mcp status",
      "nemoclaw <name> mcp restart",
      "nemoclaw <name> mcp remove",
    ]);
    expect(PUBLIC_DISPLAY_ENTRIES["sandbox:mcp"]).toHaveLength(5);
    expect(PUBLIC_DISPLAY_ENTRIES["sandbox:mcp"]?.map((entry) => entry.group)).toEqual([
      "MCP Servers",
      "MCP Servers",
      "MCP Servers",
      "MCP Servers",
      "MCP Servers",
    ]);
  });
});
