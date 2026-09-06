// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const runSandboxSnapshot = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const enforceRemovedImmutabilityMigrationBoundary = vi.hoisted(() => vi.fn());

vi.mock("../../lib/actions/sandbox/snapshot", () => ({
  runSandboxSnapshot,
}));
vi.mock("../../lib/state/migrations/removed-immutability", () => ({
  enforceRemovedImmutabilityMigrationBoundary,
  reportRemovedImmutabilityUpgrade: vi.fn(),
}));

import SnapshotCommand from "./snapshot";
import SnapshotCreateCommand from "./snapshot/create";
import SnapshotListCommand from "./snapshot/list";
import SnapshotRestoreCommand from "./snapshot/restore";

const rootDir = process.cwd();

describe("snapshot oclif commands", () => {
  beforeEach(() => {
    runSandboxSnapshot.mockClear();
    enforceRemovedImmutabilityMigrationBoundary.mockClear();
  });

  it("shows parent snapshot usage through the action", { timeout: 30_000 }, async () => {
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
      force: undefined,
      yes: undefined,
    });
    expect(enforceRemovedImmutabilityMigrationBoundary).toHaveBeenCalledWith("alpha");
    expect(enforceRemovedImmutabilityMigrationBoundary).toHaveBeenCalledWith("beta");
  });

  it("threads --force and --yes into the typed restore action (#3756)", async () => {
    await SnapshotRestoreCommand.run(["alpha", "--to", "beta", "--force", "--yes"], rootDir);

    expect(runSandboxSnapshot).toHaveBeenCalledWith("alpha", {
      kind: "restore",
      selector: undefined,
      to: "beta",
      force: true,
      yes: true,
    });
  });

  it("does not clone a legacy-state source image into a replacement sandbox", async () => {
    enforceRemovedImmutabilityMigrationBoundary.mockImplementationOnce(() => {
      throw new Error("legacy mutable posture cannot be proven");
    });

    await expect(
      SnapshotRestoreCommand.run(["alpha", "v2", "--to", "beta"], rootDir),
    ).rejects.toThrow("legacy mutable posture cannot be proven");

    expect(runSandboxSnapshot).not.toHaveBeenCalled();
  });

  it("runs snapshot create with an optional label", async () => {
    await SnapshotCreateCommand.run(["alpha", "--name", "before-upgrade"], rootDir);

    expect(runSandboxSnapshot).toHaveBeenCalledWith("alpha", {
      kind: "create",
      name: "before-upgrade",
    });
  });
});
