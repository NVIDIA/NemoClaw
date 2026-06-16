// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backupSandboxStateMock = vi.fn();
const captureOpenshellMock = vi.fn(() => ({ status: 0, output: "alpha Ready\n" }));
const dockerInspectMock = vi.fn(() => ({ status: 0, stdout: "true\n" }));
const getSandboxMock = vi.fn(() => null);
const findBackupMock = vi.fn();
const isGatewayHealthyMock = vi.fn(() => true);
const isShieldsDownMock = vi.fn();
const listBackupsMock = vi.fn<() => Array<Record<string, unknown>>>(() => []);
const parseLiveSandboxNamesMock = vi.fn(() => new Set(["alpha"]));
const restoreSandboxStateMock = vi.fn();

vi.mock("../../adapters/docker", () => ({
  dockerCapture: vi.fn(() => ""),
  dockerInspect: dockerInspectMock,
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: captureOpenshellMock,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(() => ({ status: 0, output: "" })),
}));

vi.mock("../../credentials/store", () => ({
  prompt: vi.fn(),
}));

vi.mock("../../domain/sandbox/destroy", () => ({
  getSandboxDeleteOutcome: vi.fn(() => ({ alreadyGone: false })),
}));

vi.mock("../../policy", () => ({}));

vi.mock("../../runner", () => ({
  ROOT: "/repo",
  run: vi.fn(() => ({ status: 0 })),
  shellQuote: (value: string) => `'${value}'`,
  validateName: vi.fn(),
}));

vi.mock("../../runtime-recovery", () => ({
  parseLiveSandboxNames: parseLiveSandboxNamesMock,
}));

vi.mock("../../shields", () => ({
  isShieldsDown: isShieldsDownMock,
  repairMutableConfigPerms: vi.fn(() => ({ applied: true, verified: true, errors: [] })),
}));

vi.mock("../../state/gateway", () => ({
  isGatewayHealthy: isGatewayHealthyMock,
}));

vi.mock("../../state/registry", () => ({
  getSandbox: getSandboxMock,
  registerSandbox: vi.fn(),
  removeSandbox: vi.fn(),
}));

vi.mock("../../state/sandbox", () => ({
  backupSandboxState: backupSandboxStateMock,
  findBackup: findBackupMock,
  getLatestBackup: vi.fn(() => null),
  listBackups: listBackupsMock,
  restoreSandboxState: restoreSandboxStateMock,
}));

vi.mock("./destroy", () => ({
  cleanupShieldsDestroyArtifacts: vi.fn(),
  removeSandboxRegistryEntry: vi.fn(),
}));

describe("runSandboxSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureOpenshellMock.mockReturnValue({ status: 0, output: "alpha Ready\n" });
    dockerInspectMock.mockReturnValue({ status: 0, stdout: "true\n" });
    findBackupMock.mockReturnValue({ match: null });
    getSandboxMock.mockReturnValue(null);
    isGatewayHealthyMock.mockReturnValue(true);
    isShieldsDownMock.mockReturnValue(true);
    listBackupsMock.mockReturnValue([]);
    restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses snapshot creation before backup when the shields gate helper is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const shields = await import("../../shields");
    vi.mocked(shields).isShieldsDown = undefined as never;
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify shields state. Refusing to create snapshot.",
    );
    vi.mocked(shields).isShieldsDown = isShieldsDownMock as never;
  });

  it("creates a named snapshot after gateway, liveness, and shields checks pass", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      name: "before-upgrade",
    };
    backupSandboxStateMock.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    findBackupMock.mockReturnValue({
      match: { ...manifest, snapshotVersion: 7, name: "before-upgrade" },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "create", name: "before-upgrade" });

    expect(backupSandboxStateMock).toHaveBeenCalledWith("alpha", { name: "before-upgrade" });
    expect(findBackupMock).toHaveBeenCalledWith("alpha", manifest.timestamp);
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Creating snapshot of 'alpha' (--name before-upgrade)");
    expect(output).toContain("Snapshot v7 name=before-upgrade created");
    expect(output).toContain("/tmp/backup-alpha");
  });

  it("renders a stable snapshot list with versions, names, timestamps, and paths", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    listBackupsMock.mockReturnValue([
      {
        snapshotVersion: 1,
        name: "initial",
        timestamp: "2026-06-01T00:00:00.000Z",
        backupPath: "/tmp/alpha/v1",
      },
      {
        snapshotVersion: 2,
        name: null,
        timestamp: "2026-06-02T00:00:00.000Z",
        backupPath: "/tmp/alpha/v2",
      },
    ]);
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "list" });

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Snapshots for 'alpha'");
    expect(output).toContain("v1");
    expect(output).toContain("initial");
    expect(output).toContain("/tmp/alpha/v2");
    expect(output).toContain("2 snapshot(s). Restore with:");
  });
});
