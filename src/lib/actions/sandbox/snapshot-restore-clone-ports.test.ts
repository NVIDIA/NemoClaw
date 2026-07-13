// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";

const dashboardPortMocks = vi.hoisted(() => ({
  findAvailableDashboardPort: vi.fn(() => 18901),
  getRegistryOccupiedDashboardPorts: vi.fn(() => new Map<string, string>()),
}));

vi.mock("../../onboard/dashboard-port", () => ({
  findAvailableDashboardPort: dashboardPortMocks.findAvailableDashboardPort,
  getRegistryOccupiedDashboardPorts: dashboardPortMocks.getRegistryOccupiedDashboardPorts,
}));

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);
describe("runSandboxSnapshot restore: clone dashboard port identity", () => {
  it("allocates the auto-created clone its own dashboard port instead of inheriting the source's (#6746)", async () => {
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
            dashboardPort: 18790,
          }
        : registeredClone,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    expect(dashboardPortMocks.findAvailableDashboardPort).toHaveBeenCalledWith(
      "beta",
      18790,
      expect.any(String),
      undefined,
      expect.any(Map),
    );
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        dashboardPort: 18901,
      }),
    );
  });

  it("aborts before deleting a --force destination when no dashboard port is free (#6746)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    dashboardPortMocks.findAvailableDashboardPort.mockImplementation(() => {
      throw new Error("All dashboard ports in range 18789-18799 are occupied:");
    });
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
      dashboardPort: 18790,
    }));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", force: true, yes: true }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(dashboardPortMocks.findAvailableDashboardPort).toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain("are occupied");
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("registers a clone of a source without a dashboard port with the field unset (#6746)", async () => {
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : registeredClone,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    expect(dashboardPortMocks.findAvailableDashboardPort).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", dashboardPort: null }),
    );
  });
});
