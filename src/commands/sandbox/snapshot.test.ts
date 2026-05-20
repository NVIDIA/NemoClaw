// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const runSandboxSnapshot = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../lib/actions/sandbox/snapshot", () => ({
  runSandboxSnapshot,
}));

import SnapshotCommand from "./snapshot";
import SnapshotCreateCommand from "./snapshot/create";
import SnapshotListCommand from "./snapshot/list";
import SnapshotRestoreCommand from "./snapshot/restore";

const rootDir = process.cwd();

describe("snapshot oclif commands", () => {
  beforeEach(() => {
    runSandboxSnapshot.mockClear();
  });

  it("shows parent snapshot usage through the action", async () => {
    await SnapshotCommand.run(["alpha"], rootDir);

    expect(runSandboxSnapshot).toHaveBeenCalledWith("alpha", { kind: "help" });
  });

  it("rejects unknown parent snapshot args before dispatch", async () => {
    await expect(SnapshotCommand.run(["alpha", "bogus"], rootDir)).rejects.toThrow(/bogus/);

    expect(runSandboxSnapshot).not.toHaveBeenCalled();
  });

  it("runs snapshot list through typed action options", async () => {
    await SnapshotListCommand.run(["alpha"], rootDir);

    expect(runSandboxSnapshot).toHaveBeenCalledWith("alpha", { kind: "list" });
  });

  it("runs snapshot restore with an optional selector and target", async () => {
    await SnapshotRestoreCommand.run(["alpha", "v2", "--to", "beta"], rootDir);

    expect(runSandboxSnapshot).toHaveBeenCalledWith("alpha", {
      kind: "restore",
      selector: "v2",
      to: "beta",
    });
  });

  it("runs snapshot create with an optional label", async () => {
    await SnapshotCreateCommand.run(["alpha", "--name", "before-upgrade"], rootDir);

    expect(runSandboxSnapshot).toHaveBeenCalledWith("alpha", {
      kind: "create",
      name: "before-upgrade",
    });
  });
});
