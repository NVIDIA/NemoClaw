// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addSandboxChannel: vi.fn().mockResolvedValue(undefined),
  removeSandboxChannel: vi.fn().mockResolvedValue(undefined),
  startSandboxChannel: vi.fn().mockResolvedValue(undefined),
  stopSandboxChannel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/actions/sandbox/policy-channel", () => mocks);

import ChannelsAddCommand from "./add";
import ChannelsRemoveCommand from "./remove";
import ChannelsStartCommand from "./start";
import ChannelsStopCommand from "./stop";

const rootDir = process.cwd();

describe("channels mutation oclif commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps add flags to typed action options", async () => {
    await ChannelsAddCommand.run(["alpha", "telegram", "--dry-run"], rootDir);

    expect(mocks.addSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: true,
      force: false,
    });
  });

  // Scenario 12 (#4305): --force is threaded through to addSandboxChannel.
  it("threads --force through add to typed action options", async () => {
    await ChannelsAddCommand.run(["alpha", "telegram", "--force"], rootDir);

    expect(mocks.addSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: false,
      force: true,
    });
  });

  // Scenario 12 (#4305): omitting --force yields force:false (no implicit override).
  it("defaults force to false when --force is omitted on add", async () => {
    await ChannelsAddCommand.run(["alpha", "telegram"], rootDir);

    expect(mocks.addSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: false,
      force: false,
    });
  });

  // Scenario 12 (#4305): --force combines with --dry-run independently.
  it("threads both --force and --dry-run on add", async () => {
    await ChannelsAddCommand.run(["alpha", "telegram", "--force", "--dry-run"], rootDir);

    expect(mocks.addSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: true,
      force: true,
    });
  });

  it("maps remove/start/stop to typed action options", async () => {
    await ChannelsRemoveCommand.run(["alpha", "telegram"], rootDir);
    await ChannelsStartCommand.run(["alpha", "telegram", "--dry-run"], rootDir);
    await ChannelsStopCommand.run(["alpha", "slack"], rootDir);

    expect(mocks.removeSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: false,
      force: false,
    });
    expect(mocks.startSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: true,
      force: false,
    });
    expect(mocks.stopSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "slack",
      dryRun: false,
      force: false,
    });
  });

  // Scenario 12 (#4305): the shared flag exposes a (no-op) --force on
  // remove/start/stop too; confirm it is threaded so the no-op is faithful.
  it("threads --force through remove/start/stop (shared flag, no-op downstream)", async () => {
    await ChannelsRemoveCommand.run(["alpha", "telegram", "--force"], rootDir);
    await ChannelsStartCommand.run(["alpha", "telegram", "--force"], rootDir);
    await ChannelsStopCommand.run(["alpha", "slack", "--force"], rootDir);

    expect(mocks.removeSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: false,
      force: true,
    });
    expect(mocks.startSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: false,
      force: true,
    });
    expect(mocks.stopSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "slack",
      dryRun: false,
      force: true,
    });
  });

  it("requires a channel before dispatch", async () => {
    await expect(ChannelsAddCommand.run(["alpha"], rootDir)).rejects.toThrow(/channel/i);

    expect(mocks.addSandboxChannel).not.toHaveBeenCalled();
  });
});
