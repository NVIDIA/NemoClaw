// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diagnosticPreview, NAME_MAX_LENGTH } from "../name-validation";

const mocks = vi.hoisted(() => ({
  captureNamedGatewaySandboxListReadOnly: vi.fn(),
  captureSandboxListWithGatewayPreflightOrExit: vi.fn(),
  checkAgentVersion: vi.fn(),
  classifyUpgradeableSandboxes: vi.fn(),
  getLatestBackup: vi.fn(),
  getVersion: vi.fn(),
  listSandboxes: vi.fn(),
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
vi.mock("../sandbox/version", () => ({ checkAgentVersion: mocks.checkAgentVersion }));
vi.mock("../state/registry", () => ({
  isPublishedSandboxRegistration: (entry: { pendingRouteReservation?: true }) =>
    entry.pendingRouteReservation !== true,
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
    const inventory = {
      sandboxes: [{ name: "alpha", phase: null, readiness: "ready" as const }],
    };
    mocks.captureSandboxListWithGatewayPreflightOrExit.mockResolvedValue(inventory);
    mocks.captureNamedGatewaySandboxListReadOnly.mockResolvedValue(inventory);
    mocks.getVersion.mockReturnValue("0.0.74");
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [{ name: "alpha", provider: "nvidia-prod", model: "nemotron" }],
    });
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

  it("reports every incompatible registered name without querying a gateway in check mode (#8497)", async () => {
    const overlengthName = `a${"b".repeat(NAME_MAX_LENGTH)}`;
    const invalidFormatName = "Legacy_Name";
    const unsafeDiagnosticName = "bad\u202e::error::forged";
    const routeOnlyInvalidName = "Route_Only_Invalid";
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [
        { name: "alpha", provider: "nvidia-prod", model: "nemotron" },
        { name: overlengthName, provider: "nvidia-prod", model: "nemotron" },
        { name: invalidFormatName, provider: "nvidia-prod", model: "nemotron" },
        { name: unsafeDiagnosticName, provider: "nvidia-prod", model: "nemotron" },
        {
          name: routeOnlyInvalidName,
          provider: "nvidia-prod",
          model: "nemotron",
          pendingRouteReservation: true,
        },
      ],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await expect(upgradeSandboxes({ check: true })).resolves.toBeUndefined();

    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain(JSON.stringify(overlengthName));
    expect(output).toContain(JSON.stringify(invalidFormatName));
    expect(output).toContain(diagnosticPreview(unsafeDiagnosticName));
    expect(output).not.toContain(unsafeDiagnosticName);
    expect(output).not.toContain(JSON.stringify(routeOnlyInvalidName));
    expect(output).toContain(`1-${NAME_MAX_LENGTH} characters`);
    expect(output).toContain("create a replacement with a valid name and transfer its state");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mocks.captureNamedGatewaySandboxListReadOnly).not.toHaveBeenCalled();
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
    expect(mocks.classifyUpgradeableSandboxes).not.toHaveBeenCalled();
    expect(upgradeSandboxesDependencies.rebuildSandbox).not.toHaveBeenCalled();
  });

  it("exits before gateway preflight or rebuild when automatic mode finds an incompatible name (#8497)", async () => {
    const incompatibleNames = [`a${"b".repeat(NAME_MAX_LENGTH)}`, "Legacy_Name", "legacy--box"];
    mocks.listSandboxes.mockReturnValue({
      sandboxes: incompatibleNames.map((name) => ({
        name,
        provider: "nvidia-prod",
        model: "nemotron",
      })),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as never);

    await expect(upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    const output = errorSpy.mock.calls.flat().join("\n");
    expect(incompatibleNames.every((name) => output.includes(JSON.stringify(name)))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.captureNamedGatewaySandboxListReadOnly).not.toHaveBeenCalled();
    expect(mocks.captureSandboxListWithGatewayPreflightOrExit).not.toHaveBeenCalled();
    expect(mocks.classifyUpgradeableSandboxes).not.toHaveBeenCalled();
    expect(mocks.getLatestBackup).not.toHaveBeenCalled();
    expect(upgradeSandboxesDependencies.rebuildSandbox).not.toHaveBeenCalled();
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
