// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    vi.unstubAllEnvs();
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

  it("completes automatic port state at the shared onboard alias boundary (#10824)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-action-port-"));
    const root = path.join(home, ".nemoclaw");
    const gateways = path.join(root, "gateways");
    const stateDir = path.join(gateways, "8990");
    const pending = path.join(stateDir, "automatic-gateway-port.pending");
    const completed = path.join(stateDir, "automatic-gateway-port");
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(root, 0o700);
      fs.chmodSync(gateways, 0o700);
      fs.chmodSync(stateDir, 0o700);
      fs.writeFileSync(pending, "8990\n", { mode: 0o600 });
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8990");
      vi.stubEnv("_NEMOCLAW_AUTOMATIC_GATEWAY_PORT", "1");

      await runOnboardAction({ "non-interactive": true });

      expect(mocks.runOnboardAction).toHaveBeenCalledWith({ "non-interactive": true }, {});
      expect(fs.existsSync(pending)).toBe(false);
      expect(fs.readFileSync(completed, "utf8")).toBe("8990\n");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
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
