// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerGpuPatchResult } from "../../onboard/docker-gpu-patch";
import {
  type ManagedSupervisorRelaunchDeps,
  relaunchManagedSupervisorSession,
} from "./supervisor-relaunch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function patchResult(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "old-container-id",
    newContainerId: "new-container-id",
    originalName: "openshell-alpha",
    backupContainerName: "openshell-alpha-nemoclaw-backup",
    mode: {
      kind: "startup-command",
      label: "persistent sandbox startup command",
      device: "",
      args: [],
    },
    backupRemoved: false,
  };
}

function baseDeps(overrides: ManagedSupervisorRelaunchDeps = {}) {
  return {
    getSandbox: vi.fn(() => ({
      name: "alpha",
      agent: "openclaw",
      dashboardPort: 18789,
      openshellDriver: "docker",
    })),
    getSessionAgent: vi.fn(
      () =>
        ({
          name: "openclaw",
          displayName: "OpenClaw",
          forwardPort: 18789,
        }) as never,
    ),
    resolveDashboardPort: vi.fn(() => 18789),
    resolveContainer: vi
      .fn()
      .mockReturnValueOnce("old-container-id")
      .mockReturnValue("new-container-id"),
    inspectContainer: vi.fn(() => ({
      Config: { Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"] },
    })),
    confirmMissingSupervisor: vi.fn(() => true),
    backupState: vi.fn(() => ({
      success: true,
      manifest: {
        backupPath: "/tmp/rebuild-backups/alpha/recovery",
      },
      backedUpDirs: ["workspace"],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
    })) as never,
    restoreState: vi.fn(() => ({
      success: true,
      restoredDirs: ["workspace"],
      failedDirs: [],
      restoredFiles: [],
      failedFiles: [],
    })),
    removeBackup: vi.fn(() => true),
    recreate: vi.fn(() => patchResult()),
    finalize: vi.fn(({ supervisorReady }) =>
      supervisorReady
        ? { backupRemoved: true, rolledBack: false }
        : { backupRemoved: false, rolledBack: true },
    ),
    ...overrides,
  } satisfies ManagedSupervisorRelaunchDeps;
}

describe("relaunchManagedSupervisorSession", () => {
  it("returns null without Docker discovery when the sandbox is not registered", () => {
    const deps = baseDeps({ getSandbox: vi.fn(() => null) });

    expect(relaunchManagedSupervisorSession("missing-box", { quiet: true, deps })).toBeNull();
    expect(deps.resolveContainer).not.toHaveBeenCalled();
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("honors the troubleshooting kill switch without mutating Docker", () => {
    vi.stubEnv("NEMOCLAW_DISABLE_SUPERVISOR_RELAUNCH", "1");
    const deps = baseDeps();

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.resolveContainer).not.toHaveBeenCalled();
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("refuses a container that no longer has the legacy keepalive startup", () => {
    const deps = baseDeps({
      inspectContainer: vi.fn(() => ({
        Config: { Env: ["OPENSHELL_SANDBOX_COMMAND=env nemoclaw-start"] },
      })),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("refuses recreation when the pinned container no longer proves supervisor absence", () => {
    const deps = baseDeps({ confirmMissingSupervisor: vi.fn(() => false) });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.confirmMissingSupervisor).toHaveBeenCalledWith("old-container-id");
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("pins the selected container and persists only a credential-free startup command", () => {
    vi.stubEnv("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS", "CUSTOM_PROVIDER_CREDENTIAL");
    vi.stubEnv("CUSTOM_PROVIDER_CREDENTIAL", "s3cr3t-token");
    vi.stubEnv("HTTPS_PROXY", "http://proxyuser:proxypass@proxy.example:8080");
    const deps = baseDeps();

    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch).not.toBeNull();
    expect(relaunch?.containerId).toBe("new-container-id");
    expect(deps.recreate).toHaveBeenCalledOnce();
    const options = vi.mocked(deps.recreate).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      sandboxName: "alpha",
      expectedOldContainerId: "old-container-id",
      waitForSupervisor: false,
    });
    const serialized = options?.openshellSandboxCommand.join(" ") ?? "";
    expect(serialized).toContain("NEMOCLAW_DASHBOARD_PORT=18789");
    expect(serialized).toMatch(/nemoclaw-start$/);
    expect(serialized).not.toContain("s3cr3t-token");
    expect(serialized).not.toContain("CUSTOM_PROVIDER_CREDENTIAL");
    expect(serialized).not.toContain("proxypass");

    expect(relaunch?.finalize(true)).toEqual({
      backupRemoved: true,
      rolledBack: false,
      stateRestored: true,
      stateBackupRemoved: true,
    });
    expect(deps.restoreState).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/recovery");
    expect(deps.removeBackup).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/recovery");
    expect(deps.finalize).toHaveBeenCalledWith({
      result: expect.objectContaining({ newContainerId: "new-container-id" }),
      supervisorReady: true,
    });
  });

  it("rolls the container transaction back when managed readiness is not proven", () => {
    const deps = baseDeps();
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(false)).toEqual({
      backupRemoved: false,
      rolledBack: true,
      stateRestored: false,
      stateBackupRemoved: true,
    });
    expect(deps.restoreState).not.toHaveBeenCalled();
    expect(deps.removeBackup).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/recovery");
    expect(deps.finalize).toHaveBeenCalledWith({
      result: expect.objectContaining({ backupContainerName: expect.any(String) }),
      supervisorReady: false,
    });
  });

  it("removes a partial state backup before it refuses recreation (#7404)", () => {
    const deps = baseDeps({
      backupState: vi.fn(() => ({
        success: false,
        manifest: {
          backupPath: "/tmp/rebuild-backups/alpha/partial-recovery",
        } as never,
        backedUpDirs: [],
        failedDirs: ["workspace"],
        backedUpFiles: [],
        failedFiles: [],
      })),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.removeBackup).toHaveBeenCalledWith(
      "alpha",
      "/tmp/rebuild-backups/alpha/partial-recovery",
    );
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("rolls back the container transaction when state restore fails", () => {
    const deps = baseDeps({
      restoreState: vi.fn(() => ({
        success: false,
        restoredDirs: [],
        failedDirs: ["workspace"],
        restoredFiles: [],
        failedFiles: [],
      })),
    });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(true)).toEqual({
      backupRemoved: false,
      rolledBack: true,
      stateRestored: false,
      stateBackupRemoved: true,
    });
    expect(deps.removeBackup).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/recovery");
    expect(deps.finalize).toHaveBeenCalledWith({
      result: expect.objectContaining({ backupContainerName: expect.any(String) }),
      supervisorReady: false,
    });
  });

  it("rolls back before restore when the replacement container identity changes", () => {
    const deps = baseDeps({
      resolveContainer: vi
        .fn()
        .mockReturnValueOnce("old-container-id")
        .mockReturnValue("different-container-id"),
    });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(true)).toEqual({
      backupRemoved: false,
      rolledBack: true,
      stateRestored: false,
      stateBackupRemoved: true,
    });
    expect(deps.restoreState).not.toHaveBeenCalled();
    expect(deps.removeBackup).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/recovery");
    expect(deps.finalize).toHaveBeenCalledWith({
      result: expect.objectContaining({ backupContainerName: expect.any(String) }),
      supervisorReady: false,
    });
  });

  it("retains the state backup when rollback fails", () => {
    const deps = baseDeps({
      finalize: vi.fn(() => ({ backupRemoved: false, rolledBack: false })),
    });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(false)).toEqual({
      backupRemoved: false,
      rolledBack: false,
      stateRestored: false,
    });
    expect(deps.removeBackup).not.toHaveBeenCalled();
  });

  it("reports best-effort state-backup cleanup failure after a successful restore", () => {
    const deps = baseDeps({ removeBackup: vi.fn(() => false) });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(true)).toEqual({
      backupRemoved: true,
      rolledBack: false,
      stateRestored: true,
      stateBackupRemoved: false,
    });
  });

  it("returns null when the pinned recreation fails", () => {
    const deps = baseDeps({
      recreate: vi.fn(() => {
        throw new Error("container identity changed");
      }),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.removeBackup).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/recovery");
  });

  it("preserves the recreation diagnostic when state-backup cleanup throws", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = baseDeps({
      removeBackup: vi.fn(() => {
        throw new Error("backup cleanup failed");
      }),
      recreate: vi.fn(() => {
        throw new Error("container identity changed");
      }),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: false, deps })).toBeNull();
    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("container identity changed");
    expect(output).not.toContain("backup cleanup failed");
  });

  it("redacts diagnostics when trusted recreation fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = baseDeps({
      recreate: vi.fn(() => {
        throw new Error(
          "OPENAI_API_KEY=sk-recovery-secret HTTPS_PROXY=http://proxyuser:proxypass@proxy.example:8080",
        );
      }),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: false, deps })).toBeNull();
    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("OPENAI_API_KEY=<REDACTED>");
    expect(output).not.toContain("sk-recovery-secret");
    expect(output).not.toContain("proxyuser");
    expect(output).not.toContain("proxypass");
  });
});
