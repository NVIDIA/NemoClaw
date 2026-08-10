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

  it.each([
    "terminal",
    "timeout",
  ] as const)("sets exit code 1 for a non-ready %s JSON result (#7383)", async (state) => {
    showSandboxChannelStatusMock.mockResolvedValue({ schemaVersion: 1, readiness: { state } });

    await SandboxChannelsStatusCommand.run(
      ["alpha", "--channel", "slack", "--wait", "--json"],
      rootDir,
    );

    expect(showSandboxChannelStatusMock).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ timeoutSeconds: 180 }),
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects --wait without one channel (#7383)", async () => {
    await expect(SandboxChannelsStatusCommand.run(["alpha", "--wait"], rootDir)).rejects.toThrow(
      /channel/i,
    );
    expect(showSandboxChannelStatusMock).not.toHaveBeenCalled();
  });

  it("rejects --timeout without --wait (#7383)", async () => {
    await expect(
      SandboxChannelsStatusCommand.run(["alpha", "--channel", "slack", "--timeout", "45"], rootDir),
    ).rejects.toThrow(/wait/i);
    expect(showSandboxChannelStatusMock).not.toHaveBeenCalled();
  });
});
