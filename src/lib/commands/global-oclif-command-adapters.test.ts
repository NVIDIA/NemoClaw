// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildListCommandDeps: vi.fn(),
  buildStatusCommandDeps: vi.fn(),
  getSandboxInventory: vi.fn(),
  getStatusReport: vi.fn(),
  renderSandboxInventoryText: vi.fn(),
  runBackupAllAction: vi.fn(),
  runGarbageCollectImagesAction: vi.fn(),
  runOnboardAction: vi.fn(),
  runSetupAction: vi.fn(),
  runSetupSparkAction: vi.fn(),
  runUpgradeSandboxesAction: vi.fn(),
  showStatusCommand: vi.fn(),
}));

vi.mock("../inventory-commands", () => ({
  getSandboxInventory: mocks.getSandboxInventory,
  getStatusReport: mocks.getStatusReport,
  renderSandboxInventoryText: mocks.renderSandboxInventoryText,
  showStatusCommand: mocks.showStatusCommand,
}));

vi.mock("../list-command-deps", () => ({
  buildListCommandDeps: mocks.buildListCommandDeps,
}));

vi.mock("../status-command-deps", () => ({
  buildStatusCommandDeps: mocks.buildStatusCommandDeps,
}));

vi.mock("../global-cli-actions", () => ({
  runBackupAllAction: mocks.runBackupAllAction,
  runGarbageCollectImagesAction: mocks.runGarbageCollectImagesAction,
  runOnboardAction: mocks.runOnboardAction,
  runSetupAction: mocks.runSetupAction,
  runSetupSparkAction: mocks.runSetupSparkAction,
  runUpgradeSandboxesAction: mocks.runUpgradeSandboxesAction,
}));

import ListCommand from "./list";
import BackupAllCommand from "./maintenance/backup-all";
import GarbageCollectImagesCommand from "./maintenance/gc";
import UpgradeSandboxesCommand from "./maintenance/upgrade-sandboxes";
import OnboardCliCommand from "./onboard";
import SetupCliCommand from "./setup";
import SetupSparkCliCommand from "./setup-spark";
import StatusCommand from "./status";

const rootDir = process.cwd();

describe("global oclif command adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildListCommandDeps.mockReturnValue({ getLiveInference: vi.fn() });
    mocks.buildStatusCommandDeps.mockReturnValue({ statusDeps: true });
    mocks.getSandboxInventory.mockResolvedValue({ sandboxes: [] });
    mocks.getStatusReport.mockReturnValue({ sandboxes: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs list through inventory helpers", async () => {
    await ListCommand.run([], rootDir);

    expect(mocks.buildListCommandDeps).toHaveBeenCalledWith();
    expect(mocks.getSandboxInventory).toHaveBeenCalledWith({ getLiveInference: expect.any(Function) });
    expect(mocks.renderSandboxInventoryText).toHaveBeenCalledWith(
      { sandboxes: [] },
      expect.any(Function),
      null,
    );
  });

  it("runs status through status helpers", async () => {
    await StatusCommand.run([], rootDir);

    expect(mocks.buildStatusCommandDeps).toHaveBeenCalledWith(rootDir);
    expect(mocks.showStatusCommand).toHaveBeenCalledWith({ statusDeps: true });
  });

  it("maps maintenance flags to typed action options", async () => {
    await BackupAllCommand.run([], rootDir);
    await UpgradeSandboxesCommand.run(["--check", "--yes"], rootDir);
    await GarbageCollectImagesCommand.run(["--dry-run", "--force"], rootDir);

    expect(mocks.runBackupAllAction).toHaveBeenCalledWith();
    expect(mocks.runUpgradeSandboxesAction).toHaveBeenCalledWith({
      auto: false,
      check: true,
      yes: true,
    });
    expect(mocks.runGarbageCollectImagesAction).toHaveBeenCalledWith({
      dryRun: true,
      force: true,
      yes: false,
    });
  });

  it("maps onboard-family flags into the compatibility action arguments", async () => {
    await OnboardCliCommand.run(["--name", "alpha", "--resume"], rootDir);
    await SetupCliCommand.run(["--fresh"], rootDir);
    await SetupSparkCliCommand.run(["--control-ui-port", "18080"], rootDir);

    expect(mocks.runOnboardAction).toHaveBeenCalledWith(["--resume", "--name", "alpha"]);
    expect(mocks.runSetupAction).toHaveBeenCalledWith(["--fresh"]);
    expect(mocks.runSetupSparkAction).toHaveBeenCalledWith(["--control-ui-port", "18080"]);
  });
});
