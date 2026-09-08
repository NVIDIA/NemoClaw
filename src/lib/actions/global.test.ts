// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backupAll: vi.fn(),
  garbageCollectImages: vi.fn().mockResolvedValue(undefined),
  help: vi.fn(),
  recoverNamedGatewayRuntime: vi.fn().mockResolvedValue({ recovered: true }),
  runOnboardAction: vi.fn().mockResolvedValue(undefined),
  version: vi.fn(),
}));

vi.mock("../gateway-runtime-action", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
}));
vi.mock("./maintenance", () => ({
  backupAll: mocks.backupAll,
  garbageCollectImages: mocks.garbageCollectImages,
}));
vi.mock("./onboard", () => ({
  runOnboardAction: mocks.runOnboardAction,
}));
vi.mock("./root-help", () => ({ help: mocks.help, version: mocks.version }));

import {
  listManagedMcpCredentialReservations,
  recoverNamedGatewayRuntime,
  runBackupAllAction,
  runGarbageCollectImagesAction,
  runOnboardAction,
  runUpgradeSandboxesAction,
  setGlobalCliActionRuntimeHooksForTest,
  showRootHelp,
  showVersion,
} from "./global";

describe("global cli action facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setGlobalCliActionRuntimeHooksForTest({});
  });

  it("forwards onboarding, maintenance, and help actions", async () => {
    const onboardRuntimeDeps = { googlechatTunnelRuntime: {} };
    await runOnboardAction({ resume: true }, onboardRuntimeDeps);
    await runBackupAllAction();
    await runGarbageCollectImagesAction({ dryRun: true });
    showRootHelp();
    showVersion();

    expect(mocks.runOnboardAction).toHaveBeenCalledWith({ resume: true }, onboardRuntimeDeps);
    expect(mocks.backupAll).toHaveBeenCalledWith();
    expect(mocks.garbageCollectImages).toHaveBeenCalledWith({ dryRun: true });
    expect(mocks.help).toHaveBeenCalledWith();
    expect(mocks.version).toHaveBeenCalledWith();
  });

  it("uses injected runtime hooks for gateway recovery and upgrades", async () => {
    const recoverHook = vi.fn().mockResolvedValue({ recovered: false });
    const upgradeHook = vi.fn().mockResolvedValue(undefined);
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: recoverHook,
      upgradeSandboxes: upgradeHook,
    });

    await expect(recoverNamedGatewayRuntime()).resolves.toEqual({ recovered: false });
    await runUpgradeSandboxesAction({ check: true });

    expect(recoverHook).toHaveBeenCalledWith();
    expect(upgradeHook).toHaveBeenCalledWith({ check: true });
  });

  it("uses default gateway recovery without an injected hook", async () => {
    await expect(recoverNamedGatewayRuntime()).resolves.toEqual({ recovered: true });

    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledWith();
  });

  it("uses an injected managed MCP credential reservation query (#9388)", () => {
    const listReservations = vi.fn(() => [
      {
        sandboxName: "hermes",
        server: "maas-glean",
        credentialKeys: ["MAAS_GLEAN_TOKEN"],
      },
    ]);
    setGlobalCliActionRuntimeHooksForTest({
      listManagedMcpCredentialReservations: listReservations,
    });

    expect(listManagedMcpCredentialReservations()).toEqual([
      {
        sandboxName: "hermes",
        server: "maas-glean",
        credentialKeys: ["MAAS_GLEAN_TOKEN"],
      },
    ]);
    expect(listReservations).toHaveBeenCalledWith();
  });
});
