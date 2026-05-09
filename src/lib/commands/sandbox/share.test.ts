// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  printShareUsageAndExit: vi.fn(() => {
    throw new Error("share usage requested");
  }),
  runShareMount: vi.fn().mockResolvedValue(undefined),
  runShareStatus: vi.fn(),
  runShareUnmount: vi.fn(),
}));

vi.mock("../../share-command", () => ({
  printShareUsageAndExit: mocks.printShareUsageAndExit,
  runShareMount: mocks.runShareMount,
  runShareStatus: mocks.runShareStatus,
  runShareUnmount: mocks.runShareUnmount,
}));

import ShareCommand from "./share";
import ShareMountCommand from "./share/mount";
import ShareStatusCommand from "./share/status";
import ShareUnmountCommand from "./share/unmount";

const rootDir = process.cwd();

describe("share oclif command adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes parent share usage through the usage action", async () => {
    await expect(ShareCommand.run(["alpha"], rootDir)).rejects.toThrow("share usage requested");

    expect(mocks.printShareUsageAndExit).toHaveBeenCalledWith(1);
  });

  it("maps share subcommand args to share actions", async () => {
    await ShareMountCommand.run(["alpha", "/workspace", "/tmp/alpha"], rootDir);
    await ShareUnmountCommand.run(["alpha", "/tmp/alpha"], rootDir);
    await ShareStatusCommand.run(["alpha", "/tmp/alpha"], rootDir);

    expect(mocks.runShareMount).toHaveBeenCalledWith({
      sandboxName: "alpha",
      remotePath: "/workspace",
      localMount: "/tmp/alpha",
    });
    expect(mocks.runShareUnmount).toHaveBeenCalledWith({
      sandboxName: "alpha",
      localMount: "/tmp/alpha",
    });
    expect(mocks.runShareStatus).toHaveBeenCalledWith({
      sandboxName: "alpha",
      localMount: "/tmp/alpha",
    });
  });
});
