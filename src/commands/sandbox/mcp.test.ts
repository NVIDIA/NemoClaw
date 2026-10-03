// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { MCP_BRIDGE_SUBCOMMANDS_USAGE } from "../../lib/actions/sandbox/mcp-bridge/usage";

const mocks = vi.hoisted(() => ({
  dispatchMcpBridgeCommand: vi.fn().mockResolvedValue(undefined),
  moduleLoaded: vi.fn(),
  rebuildSandbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/actions/sandbox/mcp-bridge", () => {
  mocks.moduleLoaded();
  return {
    dispatchMcpBridgeCommand: mocks.dispatchMcpBridgeCommand,
  };
});
vi.mock("../../lib/actions/sandbox/rebuild", () => ({
  rebuildSandbox: mocks.rebuildSandbox,
}));

import SandboxMcpCommand from "./mcp";

const rootDir = process.cwd();

describe("sandbox MCP oclif command", () => {
  it("runs migration rebuild through the typed public command boundary", async () => {
    expect(mocks.moduleLoaded).not.toHaveBeenCalled();
    mocks.dispatchMcpBridgeCommand.mockImplementationOnce(async (name, _args, dependencies) =>
      dependencies.rebuildForMigration?.(name),
    );

    await SandboxMcpCommand.run(["alpha", "migrate", "--apply"], rootDir);

    expect(mocks.moduleLoaded).toHaveBeenCalledOnce();
    expect(mocks.dispatchMcpBridgeCommand).toHaveBeenCalledWith(
      "alpha",
      ["migrate", "--apply"],
      expect.objectContaining({ rebuildForMigration: expect.any(Function) }),
    );
    expect(mocks.rebuildSandbox).toHaveBeenCalledWith(
      "alpha",
      { yes: true },
      { throwOnError: true },
    );
  });

  it("lists update in the static usage", () => {
    expect(SandboxMcpCommand.usage).toEqual([`<name> ${MCP_BRIDGE_SUBCOMMANDS_USAGE} [args...]`]);
  });

  it("lists update in the missing-sandbox error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await SandboxMcpCommand.run([], rootDir);

    expect(errorSpy).toHaveBeenCalledWith(
      `Usage: nemoclaw <sandbox> mcp ${MCP_BRIDGE_SUBCOMMANDS_USAGE} [args...]`,
    );
    errorSpy.mockRestore();
  });
});
