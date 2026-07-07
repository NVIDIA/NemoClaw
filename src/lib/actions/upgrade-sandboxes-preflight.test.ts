// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureSandboxListWithGatewayPreflightOrExit: vi.fn(),
  checkAgentVersion: vi.fn(),
  classifyUpgradeableSandboxes: vi.fn(),
  getVersion: vi.fn(),
  listSandboxes: vi.fn(),
  parseLiveSandboxEntries: vi.fn(),
  parseReadySandboxNames: vi.fn(),
  prompt: vi.fn(),
  rebuildSandbox: vi.fn(),
  shouldSkipUpgradeConfirmation: vi.fn(),
  splitRebuildableSandboxes: vi.fn(),
}));

vi.mock("../cli/branding", () => ({ CLI_NAME: "nemoclaw" }));
vi.mock("../cli/terminal-style", () => ({ B: "", D: "", G: "", R: "", YW: "" }));
vi.mock("../core/version", () => ({ getVersion: mocks.getVersion }));
vi.mock("../credentials/store", () => ({ prompt: mocks.prompt }));
vi.mock("../domain/lifecycle/options", () => ({
  normalizeUpgradeSandboxesOptions: (options: unknown) => options,
}));
vi.mock("../domain/maintenance/upgrade", () => ({
  classifyUpgradeableSandboxes: mocks.classifyUpgradeableSandboxes,
  shouldSkipUpgradeConfirmation: mocks.shouldSkipUpgradeConfirmation,
  splitRebuildableSandboxes: mocks.splitRebuildableSandboxes,
}));
vi.mock("../openshell-sandbox-list", () => ({
  captureSandboxListWithGatewayPreflightOrExit: mocks.captureSandboxListWithGatewayPreflightOrExit,
}));
vi.mock("../runtime-recovery", () => ({
  parseLiveSandboxEntries: mocks.parseLiveSandboxEntries,
  parseReadySandboxNames: mocks.parseReadySandboxNames,
}));
vi.mock("../sandbox/version", () => ({ checkAgentVersion: mocks.checkAgentVersion }));
vi.mock("../state/registry", () => ({ listSandboxes: mocks.listSandboxes }));
vi.mock("../state/sandbox", () => ({}));
vi.mock("./sandbox/rebuild", () => ({ rebuildSandbox: mocks.rebuildSandbox }));

import { upgradeSandboxes } from "./upgrade-sandboxes";

describe("upgrade-sandboxes gateway preflight adapter (#6237)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "");
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "alpha Ready",
    });
    mocks.getVersion.mockReturnValue("0.0.74");
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha", provider: "nvidia-prod", model: "nemotron" }],
    });
    mocks.parseLiveSandboxEntries.mockReturnValue([{ name: "alpha", phase: "Ready" }]);
    mocks.parseReadySandboxNames.mockReturnValue(new Set(["alpha"]));
    mocks.classifyUpgradeableSandboxes.mockReturnValue({ stale: [], unknown: [] });
    mocks.shouldSkipUpgradeConfirmation.mockReturnValue(true);
    mocks.splitRebuildableSandboxes.mockReturnValue({ rebuildable: [], stopped: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns before gateway preflight when the registry is empty", async () => {
    mocks.listSandboxes.mockReturnValue({ sandboxes: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await upgradeSandboxes({ check: true });

    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
    expect(mocks.classifyUpgradeableSandboxes).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("No sandboxes found");
  });

  it("passes upgrade context and the successful Ready set into classification", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await upgradeSandboxes({ check: true });

    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).toHaveBeenCalledWith({
      action: "checking sandbox upgrade state",
      command: "nemoclaw upgrade-sandboxes",
    });
    expect(mocks.classifyUpgradeableSandboxes).toHaveBeenCalledWith(
      [{ name: "alpha", provider: "nvidia-prod", model: "nemotron" }],
      new Set(["alpha"]),
      expect.any(Function),
      { currentNemoclawVersion: "0.0.74" },
    );
    expect(logSpy.mock.calls.flat().join("\n")).toContain("All sandboxes are up to date");
  });

  it("does not classify or rebuild when gateway preflight exits", async () => {
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockRejectedValueOnce(
      new Error("process.exit(1)"),
    );

    await expect(upgradeSandboxes({ check: true })).rejects.toThrow("process.exit(1)");

    expect(mocks.classifyUpgradeableSandboxes).not.toHaveBeenCalled();
    expect(mocks.rebuildSandbox).not.toHaveBeenCalled();
  });
});
