// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  ChannelsAddCommand,
  ChannelsRemoveCommand,
  ChannelsStartCommand,
  ChannelsStopCommand,
  setChannelsRuntimeBridgeFactoryForTest,
} from "./channels-mutate-cli-commands";

const rootDir = process.cwd();

describe("channels mutation oclif commands", () => {
  it("maps add flags to the legacy argv shape", async () => {
    const runtime = {
      sandboxChannelsAdd: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsRemove: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsStart: vi.fn().mockResolvedValue(undefined),
      sandboxChannelsStop: vi.fn().mockResolvedValue(undefined),
    };
    setChannelsRuntimeBridgeFactoryForTest(() => runtime);

    await ChannelsAddCommand.run(["alpha", "telegram", "--dry-run"], rootDir);

    expect(runtime.sandboxChannelsAdd).toHaveBeenCalledWith("alpha", ["telegram", "--dry-run"]);
  });

  it("maps remove/start/stop to the legacy argv shape", async () => {
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

    expect(runtime.sandboxChannelsRemove).toHaveBeenCalledWith("alpha", ["telegram"]);
    expect(runtime.sandboxChannelsStart).toHaveBeenCalledWith("alpha", [
      "telegram",
      "--dry-run",
    ]);
    expect(runtime.sandboxChannelsStop).toHaveBeenCalledWith("alpha", ["slack"]);
  });
});
