// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const launchSandbox = vi.hoisted(() => vi.fn());

vi.mock("../lib/actions/sandbox/launch", () => ({ launchSandbox }));

import LaunchCommand from "./launch";

const rootDir = process.cwd();

describe("launch oclif command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    launchSandbox.mockResolvedValue(undefined);
  });

  it("forwards the sandbox name to the launch action (#6006)", async () => {
    await LaunchCommand.run(["alpha"], rootDir);

    expect(launchSandbox).toHaveBeenCalledWith("alpha");
  });

  it("requires a sandbox name (#6006)", async () => {
    await expect(LaunchCommand.run([], rootDir)).rejects.toThrow(/name/i);

    expect(launchSandbox).not.toHaveBeenCalled();
  });

  it("rejects extra positional arguments (#6006)", async () => {
    await expect(LaunchCommand.run(["alpha", "extra"], rootDir)).rejects.toThrow();

    expect(launchSandbox).not.toHaveBeenCalled();
  });
});
