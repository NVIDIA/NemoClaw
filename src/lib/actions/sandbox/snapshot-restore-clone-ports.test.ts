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
    expect(f.captureOpenshellMock).toHaveBeenCalledWith(
      ["policy", "get", "-g", "nemoclaw-18080", "--base", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
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
        gatewayName: "nemoclaw-18080",
        gatewayPort: 18080,
      }),
      undefined,
      { pending: true },
    );
    expect(registeredClone).not.toHaveProperty("policyAuthority");
    expect(registeredClone).not.toHaveProperty("policyCreationReceipt");
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
    {
      label: "authentication failure",
      policyResult: { status: 1, output: "authentication failed credential-value" },
      expected: "OpenShell could not authenticate the sandbox policy read.",
    },
    {
      label: "timeout",
      policyResult: {
        status: null,
        output: "credential-value",
        error: Object.assign(new Error("credential-value"), { code: "ETIMEDOUT" }),
      },
      expected: "The OpenShell sandbox policy read timed out.",
    },
    {
      label: "schema mismatch",
      policyResult: { status: 1, output: "invalid wire type credential-value" },
      expected: "The OpenShell CLI and gateway policy schemas do not match.",
    },
    {
      label: "gateway identity mismatch",
      policyResult: { status: 1, output: "handshake verification failed credential-value" },
      expected: "The selected OpenShell gateway identity does not match the recorded identity.",
    },
    {
      label: "unreachable gateway",
      policyResult: { status: 1, output: "connection refused credential-value" },
      expected: "OpenShell could not reach the selected gateway.",
    },
    {
      label: "command failure",
      policyResult: { status: 1, output: "unknown failure credential-value" },
      expected: "The OpenShell sandbox policy read failed.",
    },
  ] satisfies readonly {
    label: string;
    policyResult: f.OpenshellCaptureResult;
    expected: string;
  }[])(
    "keeps a --force destination when the source policy read has a $label",
    async ({ policyResult, expected }) => {
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
          "policy get": policyResult,
          "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
          "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
        }),
      );
      f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
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
          expected,
        ]),
      });
      expect(String((failure as Error).message)).toContain(
        "retry the original snapshot restore command",
      );
      expect(String((failure as Error).message)).not.toContain("credential-value");
      expect(f.lifecycleMock.events).not.toContain("delete");
      expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
      expect(f.registerSandboxMock).not.toHaveBeenCalled();
      expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    },
  );

  it("passes a single-link mode-0600 clone policy to OpenShell under a permissive umask", async () => {
    let registeredClone: f.SandboxRecord | null = null;
    let observedPolicyPath = "";
    let observedMode = 0;
    let observedLinks = 0;
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
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.streamSandboxCreateMock.mockImplementation(async (_command, args) => {
      observedPolicyPath = String(args[args.indexOf("--policy") + 1]);
      const stats = fs.statSync(observedPolicyPath);
      observedMode = stats.mode & 0o777;
      observedLinks = stats.nlink;
      return { status: 0, output: "", sawProgress: false, forcedReady: false };
    });
    const { runSandboxSnapshot } = await import("./snapshot");
    const previousUmask = process.umask(0o000);
    try {
      await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    } finally {
      process.umask(previousUmask);
    }

    expect(observedMode).toBe(0o600);
    expect(observedLinks).toBe(1);
    expect(observedPolicyPath).not.toBe("");
    expect(fs.existsSync(observedPolicyPath)).toBe(false);
  });

  it("reports non-destructive recovery when clone policy cleanup fails after registration", async () => {
    let registeredClone: f.SandboxRecord | null = null;
    let observedPolicyPath = "";
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
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.streamSandboxCreateMock.mockImplementation(async (_command, args) => {
      observedPolicyPath = String(args[args.indexOf("--policy") + 1]);
      return { status: 0, output: "", sawProgress: false, forcedReady: false };
    });
    vi.spyOn(tempFiles, "createExactTempFileCleanup").mockReturnValue(() => false);
    const { runSandboxSnapshot } = await import("./snapshot");

    try {
      const failure = await runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
      }).catch((error: unknown) => error);

      expect(f.registerSandboxMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "beta" }),
        undefined,
        { pending: true },
      );
      expect(failure).toMatchObject({
        name: "SnapshotCommandError",
        lines: expect.arrayContaining([
          expect.stringContaining(observedPolicyPath),
          "Destination 'beta' remains registered. Snapshot state was not restored.",
          expect.stringContaining("already-created destination 'beta'"),
          expect.stringContaining("explicitly destroy 'beta'"),
        ]),
      });
      expect(String((failure as Error).message)).not.toContain(
        "retrying the snapshot restore command",
      );
      expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    } finally {
      tempFiles.cleanupTempDir(observedPolicyPath, "nemoclaw-clone-policy");
    }
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
    expect(createArgs.slice(createArgs.lastIndexOf("--") + 1)).toEqual([
      "env",
      "NEMOCLAW_OBSERVABILITY=0",
      "CHAT_UI_URL=http://127.0.0.1:18902",
      "NEMOCLAW_DASHBOARD_PORT=18902",
      `${HERMES_DASHBOARD_ENABLE_ENV}=1`,
      `${HERMES_DASHBOARD_PORT_ENV}=18902`,
      `${HERMES_DASHBOARD_INTERNAL_PORT_ENV}=18901`,
      `${HERMES_DASHBOARD_TUI_ENV}=1`,
      `${HERMES_API_PORT_ENV}=8643`,
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
