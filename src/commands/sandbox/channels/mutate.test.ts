// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import ChannelsAddCommand from "./add";
import { setChannelsRuntimeBridgeFactoryForTest } from "../../../lib/sandbox/channels-command-support";
import ChannelsRemoveCommand from "./remove";
import ChannelsStartCommand from "./start";
import ChannelsStopCommand from "./stop";

const rootDir = process.cwd();

describe("channels mutation oclif commands", () => {
  it("maps add flags to typed action options", async () => {
    const runtime = {
      sandboxChannelsAdd: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsRemove: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsStart: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsStop: vi.fn().mockResolvedValue(undefined),
    };
    setChannelsRuntimeBridgeFactoryForTest(() => runtime);

    await ChannelsAddCommand.run(["alpha", "telegram", "--dry-run"], rootDir);

    expect(runtime.sandboxChannelsAdd).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: true,
    });
  });

  it("maps remove/start/stop to typed action options", async () => {
    const runtime = {
      sandboxChannelsAdd: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsRemove: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsStart: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsStop: vi.fn().mockResolvedValue(undefined),
    };
    setChannelsRuntimeBridgeFactoryForTest(() => runtime);

    await ChannelsRemoveCommand.run(["alpha", "telegram"], rootDir);
    await ChannelsStartCommand.run(["alpha", "telegram", "--dry-run"], rootDir);
    await ChannelsStopCommand.run(["alpha", "slack"], rootDir);

    expect(runtime.sandboxChannelsRemove).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: false,
    });
    expect(runtime.sandboxChannelsStart).toHaveBeenCalledWith("alpha", {
      channel: "telegram",
      dryRun: true,
    });
    expect(runtime.sandboxChannelsStop).toHaveBeenCalledWith("alpha", {
      channel: "slack",
      dryRun: false,
    });
  });

  it("requires a channel before dispatch", async () => {
    const runtime = {
      sandboxChannelsAdd: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsRemove: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsStart: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsStop: vi.fn().mockResolvedValue(undefined),
    };
    setChannelsRuntimeBridgeFactoryForTest(() => runtime);

    await expect(ChannelsAddCommand.run(["alpha"], rootDir)).rejects.toThrow(/channel/i);

    expect(runtime.sandboxChannelsAdd).not.toHaveBeenCalled();
  });
});
