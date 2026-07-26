// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addSandboxHostAlias: vi.fn(),
  listSandboxHostAliases: vi.fn(),
  removeSandboxHostAlias: vi.fn(),
}));

vi.mock("../../../lib/actions/sandbox/host-aliases", () => ({
  addSandboxHostAlias: mocks.addSandboxHostAlias,
  listSandboxHostAliases: mocks.listSandboxHostAliases,
  removeSandboxHostAlias: mocks.removeSandboxHostAlias,
}));

import HostsAddCommand from "./add";
import HostsListCommand from "./list";
import HostsRemoveCommand from "./remove";

const rootDir = process.cwd();

describe("host alias oclif command adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps parsed host alias arguments and dry-run flags to actions", async () => {
    await HostsAddCommand.run(["alpha", "searxng.local", "192.168.1.105", "--dry-run"], rootDir);
    await HostsListCommand.run(["alpha"], rootDir);
    await HostsRemoveCommand.run(["alpha", "searxng.local", "--dry-run"], rootDir);

    expect(mocks.addSandboxHostAlias).toHaveBeenCalledWith("alpha", {
      hostname: "searxng.local",
      ip: "192.168.1.105",
      dryRun: true,
    });
    expect(mocks.listSandboxHostAliases).toHaveBeenCalledWith("alpha");
    expect(mocks.removeSandboxHostAlias).toHaveBeenCalledWith("alpha", {
      hostname: "searxng.local",
      dryRun: true,
    });
  });

  it("rejects unknown flags before invoking host alias actions", async () => {
    await expect(
      HostsAddCommand.run(["alpha", "searxng.local", "192.168.1.105", "--dry-rnu"], rootDir),
    ).rejects.toThrow("Nonexistent flag: --dry-rnu");
    await expect(
      HostsRemoveCommand.run(["alpha", "searxng.local", "--force"], rootDir),
    ).rejects.toThrow("Nonexistent flag: --force");

    expect(mocks.addSandboxHostAlias).not.toHaveBeenCalled();
    expect(mocks.removeSandboxHostAlias).not.toHaveBeenCalled();
  });

  it("maps host alias action failures to command output and exit codes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.addSandboxHostAlias.mockImplementationOnce(() => {
        throw {
          name: "HostAliasesCommandError",
          lines: ["host alias failed", "try again"],
          exitCode: 5,
        };
      });

      await expect(
        HostsAddCommand.run(["alpha", "searxng.local", "192.168.1.105"], rootDir),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(5);
      expect(error).toHaveBeenCalledWith("host alias failed");
      expect(error).toHaveBeenCalledWith("try again");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });
});
