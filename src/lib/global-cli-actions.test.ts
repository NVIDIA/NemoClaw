// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backupAll: vi.fn(),
  garbageCollectImages: vi.fn().mockResolvedValue(undefined),
  help: vi.fn(),
  recoverNamedGatewayRuntime: vi.fn().mockResolvedValue({ recovered: true }),
  runDeployAction: vi.fn().mockResolvedValue(undefined),
  runOnboardAction: vi.fn().mockResolvedValue(undefined),
  runOpenshell: vi.fn(() => ({ status: 0 })),
  runSetupAction: vi.fn().mockResolvedValue(undefined),
  runSetupSparkAction: vi.fn().mockResolvedValue(undefined),
  version: vi.fn(),
}));

vi.mock("./deploy-action", () => ({ runDeployAction: mocks.runDeployAction }));
vi.mock("./gateway-runtime-action", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
}));
vi.mock("./maintenance-actions", () => ({
  backupAll: mocks.backupAll,
  garbageCollectImages: mocks.garbageCollectImages,
}));
vi.mock("./onboard-action", () => ({
  runOnboardAction: mocks.runOnboardAction,
  runSetupAction: mocks.runSetupAction,
  runSetupSparkAction: mocks.runSetupSparkAction,
}));
vi.mock("./openshell-runtime", () => ({ runOpenshell: mocks.runOpenshell }));
vi.mock("./root-help-action", () => ({ help: mocks.help, version: mocks.version }));

import {
  recoverNamedGatewayRuntime,
  runBackupAllAction,
  runDeployAction,
  runGarbageCollectImagesAction,
  runOnboardAction,
  runOpenshellProviderCommand,
  runSetupAction,
  runSetupSparkAction,
  runUpgradeSandboxesAction,
  setGlobalCliActionRuntimeHooksForTest,
  showRootHelp,
  showVersion,
} from "./global-cli-actions";

describe("global cli action facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setGlobalCliActionRuntimeHooksForTest({});
  });

  it("forwards onboarding, deploy, maintenance, and help actions", async () => {
    await runOnboardAction(["--resume"]);
    await runSetupAction(["--fresh"]);
    await runSetupSparkAction(["--name", "alpha"]);
    await runDeployAction("gpu-alpha");
    runBackupAllAction();
    await runGarbageCollectImagesAction({ dryRun: true });
    showRootHelp();
    showVersion();

    expect(mocks.runOnboardAction).toHaveBeenCalledWith(["--resume"]);
    expect(mocks.runSetupAction).toHaveBeenCalledWith(["--fresh"]);
    expect(mocks.runSetupSparkAction).toHaveBeenCalledWith(["--name", "alpha"]);
    expect(mocks.runDeployAction).toHaveBeenCalledWith("gpu-alpha");
    expect(mocks.backupAll).toHaveBeenCalledWith();
    expect(mocks.garbageCollectImages).toHaveBeenCalledWith({ dryRun: true });
    expect(mocks.help).toHaveBeenCalledWith();
    expect(mocks.version).toHaveBeenCalledWith();
  });

  it("uses injected runtime hooks for gateway recovery, OpenShell, and upgrades", async () => {
    const recoverHook = vi.fn().mockResolvedValue({ recovered: false });
    const runOpenshellHook = vi.fn(() => ({ status: 0 }));
    const upgradeHook = vi.fn().mockResolvedValue(undefined);
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: recoverHook,
      runOpenshell: runOpenshellHook as never,
      upgradeSandboxes: upgradeHook,
    });

    await expect(recoverNamedGatewayRuntime()).resolves.toEqual({ recovered: false });
    runOpenshellProviderCommand(["provider", "list"], { timeout: 100 });
    await runUpgradeSandboxesAction({ check: true });

    expect(recoverHook).toHaveBeenCalledWith();
    expect(runOpenshellHook).toHaveBeenCalledWith(["provider", "list"], { timeout: 100 });
    expect(upgradeHook).toHaveBeenCalledWith({ check: true });
  });

  it("falls back to default runtime hooks", async () => {
    await expect(recoverNamedGatewayRuntime()).resolves.toEqual({ recovered: true });
    runOpenshellProviderCommand(["provider", "list"]);

    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledWith();
    expect(mocks.runOpenshell).toHaveBeenCalledWith(["provider", "list"], undefined);
  });
});
