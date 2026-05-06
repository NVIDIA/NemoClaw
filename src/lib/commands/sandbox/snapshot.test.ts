// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import SnapshotCommand from "./snapshot";
import { setSnapshotRuntimeBridgeFactoryForTest } from "./snapshot/common";
import SnapshotCreateCommand from "./snapshot/create";
import SnapshotListCommand from "./snapshot/list";
import SnapshotRestoreCommand from "./snapshot/restore";

const rootDir = process.cwd();

describe("snapshot oclif commands", () => {
  it("shows parent snapshot usage through the action", async () => {
    const sandboxSnapshot = vi.fn().mockResolvedValue(undefined);
    setSnapshotRuntimeBridgeFactoryForTest(() => ({ sandboxSnapshot }));

    await SnapshotCommand.run(["alpha"], rootDir);

    expect(sandboxSnapshot).toHaveBeenCalledWith("alpha", []);
  });

  it("rejects unknown parent snapshot args before dispatch", async () => {
    const sandboxSnapshot = vi.fn().mockResolvedValue(undefined);
    setSnapshotRuntimeBridgeFactoryForTest(() => ({ sandboxSnapshot }));

    await expect(SnapshotCommand.run(["alpha", "bogus"], rootDir)).rejects.toThrow(/bogus/);

    expect(sandboxSnapshot).not.toHaveBeenCalled();
  });

  it("runs snapshot list through the legacy snapshot implementation", async () => {
    const sandboxSnapshot = vi.fn().mockResolvedValue(undefined);
    setSnapshotRuntimeBridgeFactoryForTest(() => ({ sandboxSnapshot }));

    await SnapshotListCommand.run(["alpha"], rootDir);

    expect(sandboxSnapshot).toHaveBeenCalledWith("alpha", ["list"]);
  });

  it("runs snapshot restore with an optional selector and target", async () => {
    const sandboxSnapshot = vi.fn().mockResolvedValue(undefined);
    setSnapshotRuntimeBridgeFactoryForTest(() => ({ sandboxSnapshot }));

    await SnapshotRestoreCommand.run(["alpha", "v2", "--to", "beta"], rootDir);

    expect(sandboxSnapshot).toHaveBeenCalledWith("alpha", ["restore", "v2", "--to", "beta"]);
  });

  it("runs snapshot create with an optional label", async () => {
    const sandboxSnapshot = vi.fn().mockResolvedValue(undefined);
    setSnapshotRuntimeBridgeFactoryForTest(() => ({ sandboxSnapshot }));

    await SnapshotCreateCommand.run(["alpha", "--name", "before-upgrade"], rootDir);

    expect(sandboxSnapshot).toHaveBeenCalledWith("alpha", [
      "create",
      "--name",
      "before-upgrade",
    ]);
  });
});
