// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
} from "../../hermes-dashboard";
import { resolveRebuildHermesDashboardEnv } from "./rebuild-durable-config";
import * as f from "./snapshot-restore-test-fixture";

const dashboardPortMocks = vi.hoisted(() => ({
  findAvailableDashboardPort: vi.fn(() => 18901),
  getRegistryOccupiedDashboardPorts: vi.fn(() => new Map<string, string>()),
  withDashboardPortReservationLock: vi.fn(async (operation: () => unknown) => await operation()),
}));

vi.mock("../../onboard/dashboard-port", () => ({
  findAvailableDashboardPort: dashboardPortMocks.findAvailableDashboardPort,
  getRegistryOccupiedDashboardPorts: dashboardPortMocks.getRegistryOccupiedDashboardPorts,
  withDashboardPortReservationLock: dashboardPortMocks.withDashboardPortReservationLock,
}));

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);
describe("runSandboxSnapshot restore: new Kubernetes destination", () => {
  it("restores a Kubernetes clone after Ready without invoking the retired DNS proxy", async () => {
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            gatewayName: "nemoclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "kubernetes",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : registeredClone,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const actualExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) =>
        String(candidate) === "/repo/scripts/setup-dns-proxy.sh" || actualExistsSync(candidate),
    );
    f.streamSandboxCreateMock.mockImplementationOnce(async (_command, _args, _env, options) => {
      expect(options?.readyCheck?.()).toBe(true);
      return { status: 0, output: "", sawProgress: true, forcedReady: false };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.streamSandboxCreateMock).toHaveBeenCalledOnce();
    expect(f.streamSandboxCreateMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "sandbox",
        "create",
        "--name",
        "beta",
        "--from",
        "nemoclaw-alpha:live",
      ]),
    );
    expect(
      f.captureOpenshellMock.mock.calls.filter(([args]) => args.join(" ") === "sandbox list"),
    ).toHaveLength(3);
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        gatewayName: "nemoclaw",
        openshellDriver: "kubernetes",
      }),
    );
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
    expect(f.runnerRunMock).not.toHaveBeenCalled();
  });
});

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
    expect(dashboardPortMocks.withDashboardPortReservationLock).toHaveBeenCalledOnce();
    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] ?? [];
    expect(createArgs.slice(createArgs.lastIndexOf("--") + 1)).toEqual([
      "env",
      "NEMOCLAW_OBSERVABILITY=0",
      "CHAT_UI_URL=http://127.0.0.1:18901",
      "NEMOCLAW_DASHBOARD_PORT=18901",
      "nemoclaw-start",
    ]);
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        dashboardPort: 18901,
      }),
    );
  });

  it("keeps a Hermes clone rebuildable with its new public port and inherited internal port (#6746)", async () => {
    dashboardPortMocks.findAvailableDashboardPort.mockReturnValueOnce(18902);
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "hermes",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
            dashboardPort: 18790,
            hermesDashboardEnabled: true,
            hermesDashboardPort: 18790,
            hermesDashboardInternalPort: 18901,
            hermesDashboardTui: true,
          }
        : registeredClone,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
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
      new Map([["18901", "alpha (Hermes dashboard internal)"]]),
    );
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        dashboardPort: 18902,
        hermesDashboardPort: 18902,
        hermesDashboardInternalPort: 18901,
        hermesDashboardTui: true,
      }),
    );
    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] ?? [];
    expect(createArgs.slice(createArgs.lastIndexOf("--") + 1)).toEqual([
      "env",
      "NEMOCLAW_OBSERVABILITY=0",
      "CHAT_UI_URL=http://127.0.0.1:18902",
      "NEMOCLAW_DASHBOARD_PORT=18902",
      `${HERMES_DASHBOARD_ENABLE_ENV}=1`,
      `${HERMES_DASHBOARD_PORT_ENV}=18902`,
      `${HERMES_DASHBOARD_INTERNAL_PORT_ENV}=18901`,
      `${HERMES_DASHBOARD_TUI_ENV}=1`,
      "nemoclaw-start",
    ]);
    expect(resolveRebuildHermesDashboardEnv("hermes", registeredClone as never, 18902)).toEqual({
      ok: true,
      env: {
        [HERMES_DASHBOARD_ENABLE_ENV]: "1",
        [HERMES_DASHBOARD_PORT_ENV]: "18902",
        [HERMES_DASHBOARD_INTERNAL_PORT_ENV]: "18901",
        [HERMES_DASHBOARD_TUI_ENV]: "1",
      },
    });
  });

  it("aborts before deleting a --force destination when no dashboard port is free (#6746)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    dashboardPortMocks.findAvailableDashboardPort.mockImplementationOnce(() => {
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
