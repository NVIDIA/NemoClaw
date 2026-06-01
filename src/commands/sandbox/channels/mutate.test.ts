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
    });
  });

  it("maps remove/start/stop to typed action options", async () => {
    await ChannelsRemoveCommand.run(["alpha", "telegram"], rootDir);
    await ChannelsStartCommand.run(["alpha", "telegram", "--dry-run"], rootDir);
    await ChannelsStopCommand.run(["alpha", "slack"], rootDir);

    expect(mocks.removeSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: false,
    });
    expect(mocks.startSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: true,
    });
    expect(mocks.stopSandboxChannel).toHaveBeenCalledWith("alpha", {
      channel: "slack",
      dryRun: false,
    });
  });

  it("requires a channel before dispatch", async () => {
    await expect(ChannelsAddCommand.run(["alpha"], rootDir)).rejects.toThrow(/channel/i);

    expect(mocks.addSandboxChannel).not.toHaveBeenCalled();
  });
});
