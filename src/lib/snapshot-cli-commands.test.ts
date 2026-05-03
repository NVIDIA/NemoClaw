// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  setSnapshotRuntimeBridgeFactoryForTest,
  SnapshotCreateCommand,
  SnapshotListCommand,
  SnapshotRestoreCommand,
} from "./snapshot-cli-commands";

const rootDir = process.cwd();

describe("snapshot oclif commands", () => {
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
