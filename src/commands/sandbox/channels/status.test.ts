// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const showSandboxChannelStatusMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/actions/sandbox/channel-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/actions/sandbox/channel-status")>()),
  showSandboxChannelStatus: showSandboxChannelStatusMock,
}));

import SandboxChannelsStatusCommand from "./status";

const rootDir = process.cwd();

describe("SandboxChannelsStatusCommand readiness flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    showSandboxChannelStatusMock.mockResolvedValue({
      schemaVersion: 1,
      readiness: { state: "ready" },
    });
  });

  it("forwards a bounded Slack readiness wait to the action (#7383)", async () => {
    await SandboxChannelsStatusCommand.run(
      ["alpha", "--channel", "slack", "--wait", "--timeout", "45", "--json"],
      rootDir,
    );

    expect(showSandboxChannelStatusMock).toHaveBeenCalledWith("alpha", {
      channel: "slack",
      asJson: true,
      quietJson: true,
      wait: true,
      timeoutSeconds: 45,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exit code 1 for a non-ready JSON result (#7383)", async () => {
    showSandboxChannelStatusMock.mockResolvedValue({
      schemaVersion: 1,
      readiness: { state: "timeout" },
    });

    await SandboxChannelsStatusCommand.run(
      ["alpha", "--channel", "slack", "--wait", "--json"],
      rootDir,
    );

    expect(showSandboxChannelStatusMock).toHaveBeenCalledWith("alpha", {
      channel: "slack",
      asJson: true,
      quietJson: true,
      wait: true,
      timeoutSeconds: undefined,
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [["alpha"], undefined],
    [["alpha", "--channel", "slack"], "slack"],
  ] as const)("accepts the documented no-wait invocation %j (#8883)", async (argv, channel) => {
    await SandboxChannelsStatusCommand.run([...argv], rootDir);

    expect(showSandboxChannelStatusMock).toHaveBeenCalledTimes(1);
    expect(showSandboxChannelStatusMock).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ channel, wait: undefined, timeoutSeconds: undefined }),
    );
  });

  it.each([
    [["alpha", "--wait"], /channel/i],
    [["alpha", "--channel", "slack", "--timeout", "45"], /wait/i],
  ] as const)("rejects an invalid readiness flag combination (#7383)", async (args, error) => {
    await expect(SandboxChannelsStatusCommand.run([...args], rootDir)).rejects.toThrow(error);
    expect(showSandboxChannelStatusMock).not.toHaveBeenCalled();
  });
});
