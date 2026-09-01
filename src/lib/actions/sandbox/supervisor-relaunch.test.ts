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
    restartRestoredManagedGateway: vi.fn(() => true),
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
    runOpenshell: vi.fn(() => ({ status: 0, stdout: "No sandboxes found.\n" })),
    runCaptureOpenshell: vi.fn(() => "alpha  2026-08-23 10:00:00  Ready\n"),
    recreate: vi.fn(() => patchResult()),
    finalize: vi.fn(({ supervisorReady }) =>
      supervisorReady
        ? { backupRemoved: true, finalHandoffAcknowledged: true, rolledBack: false }
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
      finalHandoffAcknowledged: true,
      rolledBack: false,
      stateRestored: true,
      stateBackupRemoved: true,
    });
    expect(deps.restoreState).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/recovery");
    expect(deps.removeBackup).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/recovery");
    expect(deps.finalize).toHaveBeenCalledWith(
      {
        finalHandoffTimeoutSecs: 900,
        result: expect.objectContaining({ newContainerId: "new-container-id" }),
        sandboxName: "alpha",
        supervisorReady: true,
      },
      {
        runCaptureOpenshell: deps.runCaptureOpenshell,
        runOpenshell: deps.runOpenshell,
      },
    );
  });

  it("retains the managed Hermes browser URL during supervisor recovery", () => {
    vi.stubEnv("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS", "HERMES_RECOVERY_CREDENTIAL");
    vi.stubEnv("HERMES_RECOVERY_CREDENTIAL", "recovery-secret");
    const deps = baseDeps({
      getSandbox: vi.fn(() => ({
        name: "alpha",
        agent: "hermes",
        dashboardPort: 19189,
        hermesDashboardEnabled: true,
        hermesDashboardPort: 19189,
        hermesDashboardInternalPort: 8643,
        openshellDriver: "docker",
      })),
      getSessionAgent: vi.fn(
        () =>
          ({
            name: "hermes",
            displayName: "Hermes",
            forwardPort: 19189,
          }) as never,
      ),
      resolveDashboardPort: vi.fn(() => 19189),
      readManagedWorkloadAuthority: vi.fn(
        () =>
          ({
            agent: "hermes",
            profile: {
              dashboard: {
                agent: "hermes",
                browserUrl: "https://hermes.example.test:19189",
              },
            },
          }) as never,
      ),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).not.toBeNull();
    expect(deps.readManagedWorkloadAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "hermes", hermesDashboardEnabled: true }),
    );
    const command = vi.mocked(deps.recreate).mock.calls[0]?.[0].openshellSandboxCommand ?? [];
    expect(command).toContain("CHAT_UI_URL=https://hermes.example.test:19189");
    expect(command).not.toContain("CHAT_UI_URL=http://127.0.0.1:19189");
    expect(command.join(" ")).not.toContain("HERMES_RECOVERY_CREDENTIAL");
    expect(command.join(" ")).not.toContain("recovery-secret");
  });

  it("refuses Hermes supervisor recovery without a recorded browser URL", () => {
    const deps = baseDeps({
      getSandbox: vi.fn(() => ({
        name: "alpha",
        agent: "hermes",
        dashboardPort: 19189,
        hermesDashboardEnabled: true,
        hermesDashboardPort: 19189,
        hermesDashboardInternalPort: 8643,
        openshellDriver: "docker",
      })),
      getSessionAgent: vi.fn(
        () =>
          ({
            name: "hermes",
            displayName: "Hermes",
            forwardPort: 19189,
          }) as never,
      ),
      resolveDashboardPort: vi.fn(() => 19189),
      readManagedWorkloadAuthority: vi.fn(
        () =>
          ({
            agent: "hermes",
            profile: { dashboard: { agent: "hermes" } },
          }) as never,
      ),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    expect(deps.resolveContainer).not.toHaveBeenCalled();
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it("retries only transport-level state backup failures after a container restart", () => {
    const backupState = vi
      .fn()
      .mockReturnValueOnce({
        success: false,
        unreachable: true,
        manifest: { backupPath: "/tmp/rebuild-backups/alpha/first" },
        backedUpDirs: [],
        failedDirs: ["workspace"],
        backedUpFiles: [],
        failedFiles: [],
      })
      .mockReturnValueOnce({
        success: true,
        manifest: { backupPath: "/tmp/rebuild-backups/alpha/recovery" },
        backedUpDirs: ["workspace"],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
      });
    const sleep = vi.fn();
    const deps = baseDeps({ backupState: backupState as never, sleep });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).not.toBeNull();
    expect(backupState).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2);
    expect(deps.removeBackup).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backups/alpha/first");
    expect(deps.recreate).toHaveBeenCalledOnce();
    const dependencyOrder = [
      backupState.mock.invocationCallOrder[0],
      vi.mocked(deps.removeBackup).mock.invocationCallOrder[0],
      sleep.mock.invocationCallOrder[0],
      backupState.mock.invocationCallOrder[1],
      vi.mocked(deps.recreate).mock.invocationCallOrder[0],
    ];
    expect(dependencyOrder).toEqual([...dependencyOrder].sort((left, right) => left - right));
  });

  it("allows the state backup to succeed on the fifth retry after a restart", () => {
    const events: string[] = [];
    const unreachableBackup = {
      success: false,
      unreachable: true,
      manifest: { backupPath: "/tmp/rebuild-backups/alpha/partial" },
      backedUpDirs: [],
      failedDirs: ["workspace"],
      backedUpFiles: [],
      failedFiles: [],
    };
    const backupState = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("backup:1");
        return unreachableBackup;
      })
      .mockImplementationOnce(() => {
        events.push("backup:2");
        return unreachableBackup;
      })
      .mockImplementationOnce(() => {
        events.push("backup:3");
        return unreachableBackup;
      })
      .mockImplementationOnce(() => {
        events.push("backup:4");
        return unreachableBackup;
      })
      .mockImplementationOnce(() => {
        events.push("backup:5");
        return unreachableBackup;
      })
      .mockImplementationOnce(() => {
        events.push("backup:6");
        return {
          success: true,
          manifest: { backupPath: "/tmp/rebuild-backups/alpha/recovery" },
          backedUpDirs: ["workspace"],
          failedDirs: [],
          backedUpFiles: [],
          failedFiles: [],
        };
      });
    const removeBackup = vi.fn(() => {
      events.push("remove");
      return true;
    });
    const sleep = vi.fn((seconds: number) => {
      events.push(`sleep:${seconds}`);
    });
    const recreate = vi.fn(() => {
      events.push("recreate");
      return patchResult();
    });
    const deps = baseDeps({
      backupState: backupState as never,
      recreate,
      removeBackup,
      sleep,
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).not.toBeNull();
    expect(backupState).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(deps.removeBackup).toHaveBeenCalledTimes(5);
    expect(deps.recreate).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "backup:1",
      "remove",
      "sleep:2",
      "backup:2",
      "remove",
      "sleep:2",
      "backup:3",
      "remove",
      "sleep:2",
      "backup:4",
      "remove",
      "sleep:2",
      "backup:5",
      "remove",
      "sleep:2",
      "backup:6",
      "recreate",
    ]);
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

  it("re-proves managed health after state restore and before commit", () => {
    const order: string[] = [];
    const deps = baseDeps({
      restoreState: vi.fn(() => {
        order.push("restore-state");
        return {
          success: true,
          restoredDirs: ["workspace"],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      }),
      restartRestoredManagedGateway: vi.fn(() => {
        order.push("restart-restored-gateway");
        return true;
      }),
      finalize: vi.fn(() => {
        order.push("commit-container");
        return { backupRemoved: true, rolledBack: false };
      }),
    });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(true)).toMatchObject({
      backupRemoved: true,
      rolledBack: false,
      stateRestored: true,
    });
    expect(order).toEqual(["restore-state", "restart-restored-gateway", "commit-container"]);
    expect(deps.restartRestoredManagedGateway).toHaveBeenCalledWith("new-container-id");
    expect(deps.finalize).toHaveBeenCalledWith(
      {
        finalHandoffTimeoutSecs: 900,
        result: expect.objectContaining({ newContainerId: "new-container-id" }),
        sandboxName: "alpha",
        supervisorReady: true,
      },
      {
        runCaptureOpenshell: deps.runCaptureOpenshell,
        runOpenshell: deps.runOpenshell,
      },
    );
  });

  it("uses only an injected host sleep for lifecycle polling after recreation (#9531)", () => {
    const sleep = vi.fn();
    const deps = baseDeps({ sleep });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(true)).toMatchObject({ backupRemoved: true, rolledBack: false });
    expect(deps.finalize).toHaveBeenCalledWith(expect.objectContaining({ supervisorReady: true }), {
      runCaptureOpenshell: deps.runCaptureOpenshell,
      runOpenshell: deps.runOpenshell,
      sleep,
    });
  });

  it("rolls back when managed health fails after state restore", () => {
    const order: string[] = [];
    const deps = baseDeps({
      restoreState: vi.fn(() => {
        order.push("restore-state");
        return {
          success: true,
          restoredDirs: ["workspace"],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      }),
      restartRestoredManagedGateway: vi.fn(() => {
        order.push("restart-restored-gateway");
        return false;
      }),
      finalize: vi.fn(({ supervisorReady }) => {
        order.push(supervisorReady ? "commit-container" : "rollback-container");
        return supervisorReady
          ? { backupRemoved: true, rolledBack: false }
          : { backupRemoved: false, rolledBack: true };
      }),
    });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(true)).toEqual({
      backupRemoved: false,
      rolledBack: true,
      stateRestored: false,
      stateBackupRemoved: true,
    });
    expect(order).toEqual(["restore-state", "restart-restored-gateway", "rollback-container"]);
    expect(deps.finalize).toHaveBeenCalledWith({
      result: expect.objectContaining({ newContainerId: "new-container-id" }),
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
      finalHandoffAcknowledged: true,
      rolledBack: false,
      stateRestored: true,
      stateBackupRemoved: false,
    });
  });

  it("retains the restored state backup when final handoff is not acknowledged (#9531)", () => {
    const deps = baseDeps({
      finalize: vi.fn(() => ({
        backupRemoved: true,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: "Deleting",
        rolledBack: false,
      })),
    });
    const relaunch = relaunchManagedSupervisorSession("alpha", { quiet: true, deps });

    expect(relaunch?.finalize(true)).toEqual({
      backupRemoved: true,
      finalHandoffAcknowledged: false,
      lastSandboxPhase: "Deleting",
      rolledBack: false,
      stateRestored: true,
    });
    expect(deps.removeBackup).not.toHaveBeenCalled();
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

  it("reports a redacted verbose diagnostic for quiet recovery failures", () => {
    vi.stubEnv("NEMOCLAW_REBUILD_VERBOSE", "1");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = baseDeps({
      backupState: vi.fn(() => {
        throw new Error("OPENAI_API_KEY=sk-recovery-secret backup finalization failed");
      }),
    });

    expect(relaunchManagedSupervisorSession("alpha", { quiet: true, deps })).toBeNull();
    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Trusted container recovery could not start");
    expect(output).toContain("OPENAI_API_KEY=<REDACTED>");
    expect(output).toContain("backup finalization failed");
    expect(output).not.toContain("sk-recovery-secret");
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
