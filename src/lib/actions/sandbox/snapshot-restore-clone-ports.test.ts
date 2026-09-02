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
import { HERMES_API_PORT_ENV } from "../../onboard/hermes-api-port";
import * as tempFiles from "../../onboard/temp-files";
import { resolveRebuildHermesDashboardEnv } from "./rebuild-durable-config";
import * as f from "./snapshot-restore-test-fixture";

const dashboardPortMocks = vi.hoisted(() => ({
  findAvailableDashboardPort: vi.fn(() => 18901),
  getRegistryOccupiedDashboardPorts: vi.fn(() => new Map<string, string>()),
  getRegistryOccupiedHermesApiPorts: vi.fn(() => new Map<string, string>()),
  withDashboardPortReservationLock: vi.fn(async (operation: () => unknown) => await operation()),
}));

const hermesApiPortMocks = vi.hoisted(() => ({
  findAvailableHermesApiPort: vi.fn(() => 8643),
}));

function parseEnvironmentCommand(args: readonly string[]): {
  readonly command: string | undefined;
  readonly environment: Record<string, string>;
} {
  const delimiterIndex = args.lastIndexOf("--");
  const environment = Object.fromEntries(
    args.slice(delimiterIndex + 2, -1).map((assignment) => {
      const separatorIndex = assignment.indexOf("=");
      return [assignment.slice(0, separatorIndex), assignment.slice(separatorIndex + 1)];
    }),
  );
  return { command: args.at(-1), environment };
}

vi.mock("../../onboard/dashboard-port", () => ({
  findAvailableDashboardPort: dashboardPortMocks.findAvailableDashboardPort,
  getRegistryOccupiedDashboardPorts: dashboardPortMocks.getRegistryOccupiedDashboardPorts,
  getRegistryOccupiedHermesApiPorts: dashboardPortMocks.getRegistryOccupiedHermesApiPorts,
  withDashboardPortReservationLock: dashboardPortMocks.withDashboardPortReservationLock,
}));

vi.mock("../../onboard/hermes-api-port", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/hermes-api-port")>()),
  findAvailableHermesApiPort: hermesApiPortMocks.findAvailableHermesApiPort,
}));

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);
describe("runSandboxSnapshot restore: clone port identity", () => {
  it("allocates the auto-created clone its own dashboard port instead of inheriting the source's (#6746)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "selected-sibling");
    let registeredClone: f.SandboxRecord | null = null;
    let policyPath = "";
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
            gatewayName: "nemoclaw-18080",
            gatewayPort: 18080,
            lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
            lifecycleLiveIdentityFingerprint: "a".repeat(64),
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
    f.streamSandboxCreateMock.mockImplementation(async (_command, args) => {
      policyPath = String(args[args.indexOf("--policy") + 1]);
      const stats = fs.statSync(policyPath);
      expect(stats.mode & 0o777).toBe(0o600);
      expect(stats.nlink).toBe(1);
      return { status: 0, output: "", sawProgress: false, forcedReady: false };
    });
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
    expect(createArgs.slice(0, 6)).toEqual([
      "sandbox",
      "create",
      "-g",
      "nemoclaw-18080",
      "--name",
      "beta",
    ]);
    expect(f.readSandboxPolicyMock).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw-18080" },
      sandboxName: "alpha",
      scope: "base",
    });
    const environmentCommand = parseEnvironmentCommand(createArgs);
    expect(environmentCommand.command).toBe("nemoclaw-start");
    expect(environmentCommand.environment).toMatchObject({
      NEMOCLAW_OBSERVABILITY: "0",
      CHAT_UI_URL: "http://127.0.0.1:18901",
      NEMOCLAW_DASHBOARD_PORT: "18901",
    });
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        dashboardPort: 18901,
        gatewayName: "nemoclaw-18080",
        gatewayPort: 18080,
      }),
      undefined,
      { pending: true },
    );
    expect(registeredClone).not.toHaveProperty("policyAuthority");
    expect(registeredClone).not.toHaveProperty("policyCreationReceipt");
    expect(fs.existsSync(policyPath)).toBe(false);
  });

  it("keeps a --force destination when the source gateway binding is invalid (#7227)", async () => {
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
      dashboardPort: 18790,
      gatewayName: name === "alpha" ? "other-8080" : "nemoclaw",
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
    ).rejects.toThrow("Invalid persisted sandbox gateway binding");

    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unavailable",
      { kind: "command" as const, reason: "failed" as const, message: "OpenShell is unavailable" },
    ],
    [
      "malformed",
      { kind: "schema" as const, message: "OpenShell returned an invalid policy document" },
    ],
  ])(
    "stops before clone side effects when the typed policy read is %s",
    async (_condition, policyReadError) => {
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
              gatewayName: "nemoclaw-18080",
              gatewayPort: 18080,
            }
          : null,
      );
      f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
      f.captureOpenshellMock.mockImplementation((args) =>
        f.openshellResponses(args, {
          "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
          "sandbox list": { status: 0, output: "alpha Ready\n" },
        }),
      );
      f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
      f.readSandboxPolicyMock.mockReturnValue({ ok: false, error: policyReadError });
      const secureTempFile = vi.spyOn(tempFiles, "secureTempFile");
      const { runSandboxSnapshot } = await import("./snapshot");

      const failure = await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }).catch(
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({
        name: "SnapshotCommandError",
        lines: expect.arrayContaining([
          "Cannot read the live OpenShell policy for source sandbox 'alpha'.",
          policyReadError.message,
        ]),
      });
      expect(secureTempFile).not.toHaveBeenCalled();
      expect(f.lifecycleMock.events).not.toContain("delete");
      expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
      expect(f.registerSandboxMock).not.toHaveBeenCalled();
      expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a literal credential in the live policy before any clone handoff or restore side effect", async () => {
    const credential = "opaque-url-credential";
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
      dashboardPort: name === "alpha" ? 18790 : 18791,
    }));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.readSandboxPolicyMock.mockReturnValue({
      ok: true,
      value: {
        document: [
          "version: 1",
          "network_policies:",
          "  protected_api:",
          "    endpoints:",
          `      - host: https://operator:${credential}@api.example`,
          "",
        ].join("\n"),
        appliedRevision: null,
      },
    });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const secureTempFile = vi.spyOn(tempFiles, "secureTempFile");
    const { runSandboxSnapshot } = await import("./snapshot");

    const failure = await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "SnapshotCommandError",
      lines: expect.arrayContaining([
        "Cannot prepare a snapshot clone policy for source sandbox 'alpha' because its live OpenShell policy contains a literal credential value.",
      ]),
    });
    expect(String((failure as Error).message)).not.toContain(credential);
    expect(secureTempFile).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("refreshes the source policy before deleting a --force destination and clone creation", async () => {
    const initialPolicy = "version: 1\nnetwork_policies:\n  initial: {}\n";
    const latestPolicy = "version: 1\nnetwork_policies:\n  host_edit: {}\n";
    f.readSandboxPolicyMock
      .mockReturnValueOnce({
        ok: true,
        value: { document: initialPolicy, appliedRevision: null },
      })
      .mockReturnValue({
        ok: true,
        value: { document: latestPolicy, appliedRevision: null },
      });
    let createdPolicy = "";
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
      dashboardPort: name === "alpha" ? 18790 : 18791,
    }));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.streamSandboxCreateMock.mockImplementation(async (_command, args) => {
      createdPolicy = fs.readFileSync(String(args[args.indexOf("--policy") + 1]), "utf8");
      return { status: 0, output: "", sawProgress: false, forcedReady: false };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });

    expect(f.lifecycleMock.events).toContain("delete");
    expect(f.readSandboxPolicyMock).toHaveBeenCalledTimes(2);
    expect(createdPolicy.trim()).toBe(latestPolicy.trim());
    expect(createdPolicy).not.toContain("initial");
  });

  it("keeps a --force destination when the final pre-delete policy read fails", async () => {
    f.readSandboxPolicyMock
      .mockReturnValueOnce({
        ok: true,
        value: { document: "version: 1\nnetwork_policies: {}\n", appliedRevision: null },
      })
      .mockReturnValue({
        ok: false,
        error: {
          kind: "command",
          reason: "failed",
          message: "OpenShell policy refresh failed",
        },
      });
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
      dashboardPort: name === "alpha" ? 18790 : 18791,
    }));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const secureTempFile = vi.spyOn(tempFiles, "secureTempFile");
    const { runSandboxSnapshot } = await import("./snapshot");

    const failure = await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "SnapshotCommandError",
      lines: expect.arrayContaining([
        "Cannot read the live OpenShell policy for source sandbox 'alpha'.",
        "OpenShell policy refresh failed",
      ]),
    });
    expect(f.readSandboxPolicyMock).toHaveBeenCalledTimes(2);
    expect(secureTempFile).toHaveBeenCalledOnce();
    expect(fs.existsSync(String(secureTempFile.mock.results[0]?.value))).toBe(false);
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("gives a Hermes clone its own API port instead of the source's (#8543)", async () => {
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
            hermesApiPort: 8642,
          }
        : registeredClone,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    expect(hermesApiPortMocks.findAvailableHermesApiPort).toHaveBeenCalledWith(
      "beta",
      undefined,
      expect.any(String),
      undefined,
      expect.any(Map),
    );
    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] ?? [];
    expect(createArgs).toContain(`${HERMES_API_PORT_ENV}=8643`);
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", hermesApiPort: 8643 }),
      undefined,
      { pending: true },
    );
  });

  it("leaves a non-Hermes clone without an API port (#8543)", async () => {
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
    expect(hermesApiPortMocks.findAvailableHermesApiPort).not.toHaveBeenCalled();
    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] ?? [];
    expect(createArgs.some((arg) => arg.startsWith(HERMES_API_PORT_ENV))).toBe(false);
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", hermesApiPort: null }),
      undefined,
      { pending: true },
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
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
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
      undefined,
      { pending: true },
    );
    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] ?? [];
    const environmentCommand = parseEnvironmentCommand(createArgs);
    expect(environmentCommand.command).toBe("nemoclaw-start");
    expect(environmentCommand.environment).toMatchObject({
      NEMOCLAW_OBSERVABILITY: "0",
      CHAT_UI_URL: "http://127.0.0.1:18902",
      NEMOCLAW_DASHBOARD_PORT: "18902",
      [HERMES_DASHBOARD_ENABLE_ENV]: "1",
      [HERMES_DASHBOARD_PORT_ENV]: "18902",
      [HERMES_DASHBOARD_INTERNAL_PORT_ENV]: "18901",
      [HERMES_DASHBOARD_TUI_ENV]: "1",
      [HERMES_API_PORT_ENV]: "8643",
    });
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

  it("aborts before deleting a --force destination when no Hermes API port is free (#8543)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    hermesApiPortMocks.findAvailableHermesApiPort.mockImplementationOnce(() => {
      throw new Error("All Hermes API ports in range 8642-8652 are occupied:");
    });
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "hermes",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
      dashboardPort: 18790,
      hermesApiPort: 8642,
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

    expect(hermesApiPortMocks.findAvailableHermesApiPort).toHaveBeenCalled();
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
      undefined,
      { pending: true },
    );
  });
});
