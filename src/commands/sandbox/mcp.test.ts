// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchMcpBridgeCommand: vi.fn().mockResolvedValue(undefined),
  moduleLoaded: vi.fn(),
}));

vi.mock("../../lib/actions/sandbox/mcp-bridge", () => {
  mocks.moduleLoaded();
  return {
    dispatchMcpBridgeCommand: mocks.dispatchMcpBridgeCommand,
  };
});

import SandboxMcpCommand from "./mcp";

const rootDir = process.cwd();

describe("sandbox MCP oclif command", () => {
  it("loads the MCP lifecycle only when command execution reaches dispatch", async () => {
    expect(mocks.moduleLoaded).not.toHaveBeenCalled();

    await SandboxMcpCommand.run(["alpha", "list"], rootDir);

    expect(mocks.moduleLoaded).toHaveBeenCalledOnce();
    expect(mocks.dispatchMcpBridgeCommand).toHaveBeenCalledWith("alpha", ["list"]);
  });
});
