// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureNamedGatewaySandboxListReadOnly: vi.fn(),
  captureSandboxListWithGatewayPreflightOrExit: vi.fn(),
  checkAgentVersion: vi.fn(),
  classifyUpgradeableSandboxes: vi.fn(),
  getLatestBackup: vi.fn(),
  getVersion: vi.fn(),
  listSandboxes: vi.fn(),
  parseLiveSandboxEntries: vi.fn(),
  parseReadySandboxNames: vi.fn(),
  prompt: vi.fn(),
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
  captureNamedGatewaySandboxListReadOnly: mocks.captureNamedGatewaySandboxListReadOnly,
  captureSandboxListWithGatewayPreflightOrExit: mocks.captureSandboxListWithGatewayPreflightOrExit,
}));
vi.mock("../runtime-recovery", () => ({
  parseLiveSandboxEntries: mocks.parseLiveSandboxEntries,
  parseReadySandboxNames: mocks.parseReadySandboxNames,
}));
vi.mock("../sandbox/version", () => ({ checkAgentVersion: mocks.checkAgentVersion }));
vi.mock("../state/registry", () => ({
  isRouteOnlySandboxReservation: (entry: { pendingRouteReservation?: true; createdAt?: string }) =>
    entry.pendingRouteReservation === true && entry.createdAt === undefined,
  listSandboxes: mocks.listSandboxes,
}));
vi.mock("../state/sandbox", () => ({ getLatestBackup: mocks.getLatestBackup }));

import { upgradeSandboxes, upgradeSandboxesDependencies } from "./upgrade-sandboxes";

describe("upgrade-sandboxes gateway preflight adapter (#6237)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "");
    vi.spyOn(upgradeSandboxesDependencies, "getGatewayPort").mockReturnValue(8080);
    vi.spyOn(upgradeSandboxesDependencies, "rebuildSandbox").mockResolvedValue(undefined);
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue({
      status: 0,
      output: "alpha Ready",
    });
    mocks.captureNamedGatewaySandboxListReadOnly.mockReturnValue({
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
    expect(mocks.captureNamedGatewaySandboxListReadOnly).not.toHaveBeenCalled();
    expect(mocks.classifyUpgradeableSandboxes).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("No sandboxes found");
  });

  it("queries the sandbox's recorded gateway read-only, never the recovering preflight (#7279)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await upgradeSandboxes({ check: true });

    // Read-only, gateway-scoped list — no recover, no `gateway select`, no start.
    expect(mocks.captureNamedGatewaySandboxListReadOnly).toHaveBeenCalledWith(
      {
        action: "checking sandbox upgrade state",
        command: "nemoclaw upgrade-sandboxes",
      },
      "nemoclaw",
    );
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
    expect(mocks.classifyUpgradeableSandboxes).toHaveBeenCalledWith(
      [{ name: "alpha", provider: "nvidia-prod", model: "nemotron" }],
      new Set(["alpha"]),
      expect.any(Function),
      { currentNemoclawVersion: "0.0.74" },
    );
    expect(logSpy.mock.calls.flat().join("\n")).toContain("All sandboxes are up to date");
  });

  it("does not classify, assess backups, or rebuild when the read-only list exits on drift (#7279)", async () => {
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "1");
    // State-RPC drift is the only hard exit on the read-only check path; a plain
    // connectivity failure stays non-fatal (empty output → unobserved sandbox).
    mocks.captureNamedGatewaySandboxListReadOnly.mockImplementationOnce(() => {
      throw new Error("process.exit(1)");
    });

    await expect(upgradeSandboxes({ check: true })).rejects.toThrow("process.exit(1)");

    expect(mocks.classifyUpgradeableSandboxes).not.toHaveBeenCalled();
    expect(mocks.getLatestBackup).not.toHaveBeenCalled();
    expect(upgradeSandboxesDependencies.rebuildSandbox).not.toHaveBeenCalled();
  });

  it("targets the sandbox's recorded non-default gateway, not the ambient default (#7279)", async () => {
    // Onboarded under NEMOCLAW_GATEWAY_PORT=18080; the check runs with no env, so
    // the ambient default is 8080/`nemoclaw`. Before the fix, check pinned to the
    // ambient default, started/selected it, and stranded the real sandbox.
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [
        { name: "alpha", provider: "nvidia-prod", model: "nemotron", gatewayPort: 18080 },
      ],
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await upgradeSandboxes({ check: true });

    expect(mocks.captureNamedGatewaySandboxListReadOnly).toHaveBeenCalledWith(
      {
        action: "checking sandbox upgrade state",
        command: "nemoclaw upgrade-sandboxes",
      },
      "nemoclaw-18080",
    );
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
  });

  it("uses the ambient gateway when registered sandboxes span gateways (#7279)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [
        { name: "alpha", provider: "nvidia-prod", model: "nemotron", gatewayPort: 18080 },
        { name: "beta", provider: "nvidia-prod", model: "nemotron", gatewayPort: 18081 },
      ],
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await upgradeSandboxes({ check: true });

    expect(mocks.captureNamedGatewaySandboxListReadOnly).toHaveBeenCalledWith(
      {
        action: "checking sandbox upgrade state",
        command: "nemoclaw upgrade-sandboxes",
      },
      "nemoclaw",
    );
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
  });

  it("warns and uses the ambient gateway when all recorded bindings are invalid (#7279)", async () => {
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [
        {
          name: "alpha",
          provider: "nvidia-prod",
          model: "nemotron",
          gatewayName: "outside-nemoclaw",
        },
      ],
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await upgradeSandboxes({ check: true });

    expect(warnSpy).toHaveBeenCalledWith(
      '  Warning: sandbox "alpha" has an invalid persisted gateway binding; excluding it from check-mode gateway resolution.',
    );
    expect(mocks.captureNamedGatewaySandboxListReadOnly).toHaveBeenCalledWith(
      {
        action: "checking sandbox upgrade state",
        command: "nemoclaw upgrade-sandboxes",
      },
      "nemoclaw",
    );
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
  });

  it("leaves the auto path on the recovering preflight and ambient gateway (#7279)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await upgradeSandboxes({});

    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).toHaveBeenCalledWith(
      {
        action: "checking sandbox upgrade state",
        command: "nemoclaw upgrade-sandboxes",
      },
      { gatewayName: "nemoclaw" },
    );
    expect(mocks.captureNamedGatewaySandboxListReadOnly).not.toHaveBeenCalled();
  });
});
