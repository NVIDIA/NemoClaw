// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as forwardHealth from "../src/lib/actions/sandbox/forward-health.ts";
import {
  checkAndRecoverSandboxProcesses,
  waitForManagedGatewaySupervisor,
} from "../src/lib/actions/sandbox/process-recovery.ts";
import { relaunchManagedSupervisorSession } from "../src/lib/actions/sandbox/supervisor-relaunch.ts";
import * as openshellRuntime from "../src/lib/adapters/openshell/runtime.ts";
import * as agentRuntime from "../src/lib/agent/runtime.ts";
import * as registry from "../src/lib/state/registry.ts";

const OPENSHELL_RELAY_CHANNEL_DROPPED_STDERR = `Error:   × status: Unavailable, message: "relay
  │ channel dropped", details: [], metadata: MetadataMap { headers: {} }
`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockOpenClawSandbox(sandboxName: string, healthTimeoutSeconds = 30) {
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    name: "openclaw",
    displayName: "OpenClaw",
    forwardPort: 18789,
    healthProbe: {
      url: "http://127.0.0.1:18789/health",
      port: 18789,
      timeout_seconds: healthTimeoutSeconds,
    },
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: sandboxName,
    agent: "openclaw",
    dashboardPort: 18789,
    openshellDriver: "docker",
  });
}

function setImmediateRecoveryPolling() {
  vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
  vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "0");
  vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
  vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
}

function composedRelaunchTransaction(order: string[]) {
  const finalizeTransaction = vi.fn(({ supervisorReady }: { supervisorReady: boolean }) => {
    order.push(supervisorReady ? "commit-container" : "rollback-container");
    return supervisorReady
      ? { backupRemoved: true, rolledBack: false }
      : { backupRemoved: false, rolledBack: true };
  });
  const resolveContainer = vi
    .fn()
    .mockReturnValueOnce("old-container-id")
    .mockReturnValue("replacement-container-id");
  const relaunchManagedSupervisorSessionImpl = vi.fn(
    (sandboxName: string, options: Parameters<typeof relaunchManagedSupervisorSession>[1]) =>
      relaunchManagedSupervisorSession(sandboxName, {
        quiet: options.quiet,
        deps: {
          ...options.deps,
          resolveContainer,
          inspectContainer: vi.fn(() => ({
            Config: { Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"] },
          })),
          backupState: vi.fn(
            () =>
              ({
                success: true,
                manifest: { backupPath: "/tmp/rebuild-backups/recovery-box/recovery" },
                backedUpDirs: ["workspace"],
                failedDirs: [],
                backedUpFiles: [],
                failedFiles: [],
              }) as never,
          ),
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
          removeBackup: vi.fn(() => true),
          recreate: vi.fn(() => ({
            applied: true as const,
            oldContainerId: "old-container-id",
            newContainerId: "replacement-container-id",
            originalName: "openshell-recovery-box",
            backupContainerName: "openshell-recovery-box-nemoclaw-backup",
            mode: {
              kind: "startup-command" as const,
              label: "persistent sandbox startup command",
              device: "",
              args: [],
            },
            backupRemoved: false,
          })),
          finalize: finalizeTransaction,
        },
      }),
  );
  return { finalizeTransaction, relaunchManagedSupervisorSessionImpl };
}

function scriptedPinnedGatewayRecovery(
  order: string[],
  postRestoreRestart: { status: number; stdout: string; stderr: string },
) {
  const unavailableProbe = {
    status: 1,
    stdout: "",
    stderr: "SUPERVISOR_NOT_RUNNING",
  };
  const acceptedProbe = {
    status: 0,
    stdout: "GATEWAY_PID=4242\n",
    stderr: "",
  };
  const probeResults = [unavailableProbe, acceptedProbe] as const;
  let probeIndex = 0;
  const actions = {
    probe: () => {
      const result = probeResults[Math.min(probeIndex, probeResults.length - 1)];
      probeIndex += 1;
      return result;
    },
    recover: () => {
      throw new Error("unexpected managed gateway action: recover");
    },
    restart: () => {
      order.push("post-restore-restart");
      return postRestoreRestart;
    },
  };
  return vi.fn((_sandboxName: string, action: "probe" | "recover" | "restart") =>
    actions[action](),
  );
}

describe("waitForManagedGatewaySupervisor", () => {
  const restartingContainerId = "a".repeat(64);
  const restartingContainer = {
    status: 1,
    stdout: "",
    stderr: `Error response from daemon: Container ${restartingContainerId} is restarting, wait until the container is running`,
    managedControlRestartingContainerId: restartingContainerId,
  } as const;

  it("retries a controller probe after status 137 with no output (#8726)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce({ status: 137, stdout: "", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("stops after two status 137 controller probes with no output (#8726)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi.fn(() => ({
      status: 137,
      stdout: "",
      stderr: "",
    }));

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(false);
    expect(requestGatewaySupervisorActionImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("does not retry a status 137 controller probe with diagnostic output (#8726)", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 137,
          stdout: "",
          stderr: "container stopped",
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("waits through an exact managed-container restart transition (#8726)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce(restartingContainer)
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(requestGatewaySupervisorActionImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("stops after two managed-container restart transitions (#8726)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi.fn(() => restartingContainer);

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(false);
    expect(requestGatewaySupervisorActionImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("does not wait through an unbound Docker restart diagnostic (#8726)", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: restartingContainer.stderr,
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("waits through an exact missing-supervisor startup race", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "SUPERVISOR_NOT_RUNNING",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("waits through exact pending direct control while a clone container appears", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "PRIVILEGED_CONTROL_UNAVAILABLE",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("waits while a new clone gateway is not healthy yet (#7818)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "GATEWAY_HEALTH_TIMEOUT",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("does not wait when a health marker includes unclassified output (#7818)", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: "GATEWAY_HEALTH_TIMEOUT\nunexpected detail",
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("does not wait through an unclassified supervisor refusal", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: "prefix SUPERVISOR_NOT_RUNNING suffix",
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("does not wait through a detailed privileged-control refusal", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: "PRIVILEGED_CONTROL_UNAVAILABLE: container identity changed",
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });
});

describe("checkAndRecoverSandboxProcesses supervisor relaunch", () => {
  it("checks managed recovery and OpenShell readiness before starting host forwards (#8662)", () => {
    mockOpenClawSandbox("stopped-box");
    setImmediateRecoveryPolling();
    const order: string[] = [];
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) => {
      order.push(action);
      return {
        status: 0,
        stdout: `v1 ${"a".repeat(64)} complete ok 0 4242\nGATEWAY_PID=4242`,
        stderr: "",
      };
    });
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(() => {
      order.push("OpenShell readiness");
      return true;
    });
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValueOnce({ status: 0, output: "SANDBOX  BIND  PORT  PID  STATUS" })
      .mockReturnValue({
        status: 0,
        output: "SANDBOX  BIND  PORT  PID  STATUS\nstopped-box  127.0.0.1  18789  12345  running",
      });
    vi.spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValueOnce({ status: 0 } as never)
      .mockImplementationOnce(() => {
        order.push("host forward");
        return { status: 0 } as never;
      });

    const result = checkAndRecoverSandboxProcesses("stopped-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      waitForRecreatedSandboxOpenShellReadyImpl,
    });

    expect(result).toMatchObject({ checked: true, recovered: true, forwardRecovered: true });
    expect(result).toHaveProperty("managedControlCompletion.disposition", "ok");
    expect(order).toContain("OpenShell readiness");
    expect(order.indexOf("OpenShell readiness")).toBeLessThan(order.indexOf("host forward"));
    expect(relaunchManagedSupervisorSessionImpl).not.toHaveBeenCalled();
  });

  it("does not turn ambiguous supervisor unavailability into a container mutation", () => {
    mockOpenClawSandbox("ambiguous-box");
    setImmediateRecoveryPolling();
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_UNAVAILABLE",
    }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);

    const result = checkAndRecoverSandboxProcesses("ambiguous-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: false });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(relaunchManagedSupervisorSessionImpl).not.toHaveBeenCalled();
  });

  it("does not mutate on an embellished no-supervisor marker", () => {
    mockOpenClawSandbox("embellished-box");
    setImmediateRecoveryPolling();
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "prefix SUPERVISOR_NOT_RUNNING suffix",
    }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);

    const result = checkAndRecoverSandboxProcesses("embellished-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: false });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(relaunchManagedSupervisorSessionImpl).not.toHaveBeenCalled();
  });

  it("honors the relaunch kill switch through stable no-supervisor recovery", () => {
    vi.stubEnv("NEMOCLAW_DISABLE_SUPERVISOR_RELAUNCH", "1");
    mockOpenClawSandbox("legacy-box");
    setImmediateRecoveryPolling();
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_NOT_RUNNING",
    }));
    const resolveContainer = vi.fn(() => "old-container-id");
    const recreate = vi.fn(() => {
      throw new Error("kill switch allowed container mutation");
    });
    const requestPinnedGatewaySupervisorAction = vi.fn(() => null);
    const relaunchManagedSupervisorSessionImpl = vi.fn(
      (sandboxName: string, options: Parameters<typeof relaunchManagedSupervisorSession>[1]) =>
        relaunchManagedSupervisorSession(sandboxName, {
          quiet: options.quiet,
          deps: { ...options.deps, resolveContainer, recreate },
        }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = checkAndRecoverSandboxProcesses("legacy-box", {
      quiet: false,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: false });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(relaunchManagedSupervisorSessionImpl).toHaveBeenCalledWith(
      "legacy-box",
      expect.objectContaining({ quiet: false }),
    );
    expect(resolveContainer).not.toHaveBeenCalled();
    expect(requestPinnedGatewaySupervisorAction).not.toHaveBeenCalled();
    expect(recreate).not.toHaveBeenCalled();
    const errorLines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(errorLines).toContainEqual(
      expect.stringContaining("Failure layer: supervisor not running"),
    );
    expect(errorLines).toContainEqual(expect.stringContaining("trusted container recovery"));
    expect(errorLines).toContainEqual(expect.stringContaining("rebuild --yes"));
    expect(errorLines).not.toContainEqual(
      expect.stringContaining("Retry the managed restart from the host"),
    );
  });

  it("rolls back when recreation starts but managed control never accepts it", () => {
    mockOpenClawSandbox("rejected-box");
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({ backupRemoved: false, rolledBack: true }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) =>
      action === "recover" ? { status: 1, stdout: "", stderr: "SUPERVISOR_NOT_RUNNING" } : null,
    );
    const requestPinnedGatewaySupervisorAction = vi.fn(() => null);

    const result = checkAndRecoverSandboxProcesses("rejected-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: false });
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledWith(
      "rejected-box",
      "probe",
      210000,
      "replacement-container-id",
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(false);
  });

  it("reports a managed health failure during the recreated gateway wait", () => {
    mockOpenClawSandbox("wait-failed-box");
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({ backupRemoved: false, rolledBack: true }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_NOT_RUNNING",
    }));
    const requestPinnedGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "GATEWAY_UNSAFE_CONFIG_PATH",
    }));

    const result = checkAndRecoverSandboxProcesses("wait-failed-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail: expect.stringContaining(
        "unsafe config path: GATEWAY_UNSAFE_CONFIG_PATH",
      ),
    });
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledWith(
      "wait-failed-box",
      "probe",
      210000,
      "replacement-container-id",
    );
    expect(finalize).toHaveBeenCalledWith(false);
  });

  it("commits only after managed health accepts the recreated supervisor", () => {
    mockOpenClawSandbox("recovered-box");
    setImmediateRecoveryPolling();
    const order: string[] = [];
    const { finalizeTransaction, relaunchManagedSupervisorSessionImpl } =
      composedRelaunchTransaction(order);
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) =>
      action === "recover" ? { status: 1, stdout: "", stderr: "SUPERVISOR_NOT_RUNNING" } : null,
    );
    const requestPinnedGatewaySupervisorAction = scriptedPinnedGatewayRecovery(order, {
      status: 0,
      stdout: `v1 ${"a".repeat(64)} complete ok 4242 4343\nGATEWAY_PID=4343`,
      stderr: "",
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "SANDBOX  BIND  PORT  PID  STATUS\nrecovered-box  127.0.0.1  18789  12345  running",
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

    const result = checkAndRecoverSandboxProcesses("recovered-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: true });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("recovered-box", "recover");
    expect(relaunchManagedSupervisorSessionImpl).toHaveBeenCalledWith(
      "recovered-box",
      expect.objectContaining({
        deps: expect.objectContaining({
          restartRestoredManagedGateway: expect.any(Function),
        }),
      }),
    );
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledWith(
      "recovered-box",
      "probe",
      210000,
      "replacement-container-id",
    );
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledWith(
      "recovered-box",
      "restart",
      210000,
      "replacement-container-id",
    );
    expect(order).toEqual(["restore-state", "post-restore-restart", "commit-container"]);
    expect(finalizeTransaction).toHaveBeenCalledOnce();
    expect(finalizeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ supervisorReady: true }),
    );
  });

  it("rolls back when post-restore restart does not report an exact ok disposition", () => {
    mockOpenClawSandbox("post-restore-fail");
    setImmediateRecoveryPolling();
    const order: string[] = [];
    const { finalizeTransaction, relaunchManagedSupervisorSessionImpl } =
      composedRelaunchTransaction(order);
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) =>
      action === "recover" ? { status: 1, stdout: "", stderr: "SUPERVISOR_NOT_RUNNING" } : null,
    );
    const requestPinnedGatewaySupervisorAction = scriptedPinnedGatewayRecovery(order, {
      status: 0,
      stdout: `v1 ${"b".repeat(64)} complete already-running 4242 4242\nGATEWAY_PID=4242`,
      stderr: "",
    });
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output:
        "SANDBOX  BIND  PORT  PID  STATUS\npost-restore-fail  127.0.0.1  18789  12345  running",
    });

    const result = checkAndRecoverSandboxProcesses("post-restore-fail", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    expect(order).toEqual(["restore-state", "post-restore-restart", "rollback-container"]);
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledTimes(4);
    expect(finalizeTransaction).toHaveBeenCalledOnce();
    expect(finalizeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ supervisorReady: false }),
    );
  });

  it("reports recovery failure when state restore rolls the replacement back", () => {
    mockOpenClawSandbox("restore-failed-box");
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({
      backupRemoved: false,
      rolledBack: true,
      stateRestored: false,
    }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) =>
      action === "recover" ? { status: 1, stdout: "", stderr: "SUPERVISOR_NOT_RUNNING" } : null,
    );
    const requestPinnedGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(
      (
        _name: string,
        _options?: { beforeProbe?: (timeoutMs: number) => boolean | null; timeoutSeconds?: number },
      ) => true,
    );
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");

    const result = checkAndRecoverSandboxProcesses("restore-failed-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      waitForRecreatedSandboxOpenShellReadyImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(true);
    expect(waitForRecreatedSandboxOpenShellReadyImpl).toHaveBeenCalledOnce();
    expect(waitForRecreatedSandboxOpenShellReadyImpl).toHaveBeenCalledWith(
      "restore-failed-box",
      expect.objectContaining({ beforeProbe: expect.any(Function) }),
    );
    expect(waitForRecreatedSandboxOpenShellReadyImpl.mock.calls[0]?.[1]).not.toHaveProperty(
      "timeoutSeconds",
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("prints generic recovery hints when state recovery and rollback both fail", () => {
    mockOpenClawSandbox("restore-rollback");
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({
      backupRemoved: false,
      rolledBack: false,
      stateRestored: false,
    }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) =>
      action === "recover" ? { status: 1, stdout: "", stderr: "SUPERVISOR_NOT_RUNNING" } : null,
    );
    const requestPinnedGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = checkAndRecoverSandboxProcesses("restore-rollback", {
      quiet: false,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      waitForRecreatedSandboxOpenShellReadyImpl: vi.fn(() => true),
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain(
      "Sandbox recovery failed and the previous container could not be restored automatically.",
    );
    expect(output).toContain("rebuild --yes");
    expect(output).not.toContain("Sandbox state restore failed");
  });

  it("retries a busy pinned managed probe before starting the replacement forward", () => {
    mockOpenClawSandbox("busy-recovered-box");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "1");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    const finalize = vi.fn((supervisorReady: boolean) =>
      supervisorReady
        ? { backupRemoved: true, rolledBack: false }
        : { backupRemoved: false, rolledBack: true },
    );
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) =>
      action === "recover" ? { status: 1, stdout: "", stderr: "SUPERVISOR_NOT_RUNNING" } : null,
    );
    const acceptedProbe = {
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    };
    const requestPinnedGatewaySupervisorAction = vi
      .fn()
      .mockReturnValueOnce(acceptedProbe)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "SUPERVISOR_BUSY" })
      .mockReturnValue(acceptedProbe);
    let forwardStarted = false;
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => forwardStarted);
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockImplementation((args) => {
        const command = args.join(" ");
        const responses = {
          "sandbox exec --name busy-recovered-box -- true": () => ({
            status: 0,
            output: "",
            stdout: "",
            stderr: "",
          }),
          "forward list": () => ({
            status: 0,
            output: forwardStarted
              ? "SANDBOX  BIND  PORT  PID  STATUS\nbusy-recovered-box  127.0.0.1  18789  12345  running"
              : "SANDBOX  BIND  PORT  PID  STATUS",
          }),
        };
        return (
          responses[command as keyof typeof responses]?.() ?? {
            status: 1,
            output: "",
            stdout: "",
            stderr: "unexpected openshell command",
          }
        );
      });
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((args) => {
      forwardStarted ||= args.join(" ") === "forward start --background 18789 busy-recovered-box";
      return { status: 0 } as never;
    });

    const result = checkAndRecoverSandboxProcesses("busy-recovered-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: true,
    });
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledTimes(5);
    expect(captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "busy-recovered-box", "--", "true"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(finalize).toHaveBeenCalledWith(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18789", "busy-recovered-box"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("uses the shared recreate-readiness budget after a longer gateway health wait", () => {
    mockOpenClawSandbox("unready-box", 600);
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({ backupRemoved: true, rolledBack: false }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_NOT_RUNNING",
    }));
    const requestPinnedGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(
      (
        _name: string,
        _options?: { beforeProbe?: (timeoutMs: number) => boolean | null; timeoutSeconds?: number },
      ) => false,
    );
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");

    const result = checkAndRecoverSandboxProcesses("unready-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      waitForRecreatedSandboxOpenShellReadyImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail: expect.stringContaining("did not become ready in OpenShell"),
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(false);
    expect(waitForRecreatedSandboxOpenShellReadyImpl).toHaveBeenCalledWith(
      "unready-box",
      expect.objectContaining({ beforeProbe: expect.any(Function) }),
    );
    expect(waitForRecreatedSandboxOpenShellReadyImpl.mock.calls[0]?.[1]).not.toHaveProperty(
      "timeoutSeconds",
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reports the last structured OpenShell error when readiness times out", () => {
    mockOpenClawSandbox("relay-dropped-box");
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({ backupRemoved: true, rolledBack: false }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_NOT_RUNNING",
    }));
    const requestPinnedGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValueOnce({
        status: 1,
        output: OPENSHELL_RELAY_CHANNEL_DROPPED_STDERR.trim(),
        stdout: "",
        stderr: OPENSHELL_RELAY_CHANNEL_DROPPED_STDERR,
      })
      .mockReturnValue({
        status: null,
        output: "",
        stdout: "",
        stderr: "",
        error: timeoutError,
      });
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");

    const result = checkAndRecoverSandboxProcesses("relay-dropped-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail: expect.stringContaining(
        'Last OpenShell readiness error: Error: status: Unavailable, message: "relay channel dropped"',
      ),
    });
    expect(captureOpenshell).toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(false);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reports a definitive managed health failure separately from OpenShell readiness", () => {
    mockOpenClawSandbox("managed-failed-box");
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({ backupRemoved: true, rolledBack: false }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_NOT_RUNNING",
    }));
    const acceptedProbe = {
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    };
    const requestPinnedGatewaySupervisorAction = vi
      .fn()
      .mockReturnValueOnce(acceptedProbe)
      .mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "GATEWAY_UNSAFE_CONFIG_PATH",
      });
    const captureOpenshell = vi.spyOn(openshellRuntime, "captureOpenshell");

    const result = checkAndRecoverSandboxProcesses("managed-failed-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail: expect.stringContaining("failed the managed health guard"),
    });
    expect(result.forwardRecoveryFailureDetail).toContain(
      "unsafe config path: GATEWAY_UNSAFE_CONFIG_PATH",
    );
    expect(finalize).toHaveBeenCalledWith(false);
    expect(captureOpenshell).not.toHaveBeenCalled();
  });

  it("rejects a healthy forward when the replacement identity changes after readiness", () => {
    mockOpenClawSandbox("drifted-box");
    vi.mocked(agentRuntime.getSessionAgent).mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      forwardPort: 18789,
      forward_ports: [19000],
      healthProbe: { url: "http://127.0.0.1:18789/health", port: 18789, timeout_seconds: 30 },
    } as never);
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({ backupRemoved: true, rolledBack: false }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_NOT_RUNNING",
    }));
    const acceptedProbe = {
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    };
    const requestPinnedGatewaySupervisorAction = vi
      .fn()
      .mockReturnValueOnce(acceptedProbe)
      .mockReturnValueOnce(acceptedProbe)
      .mockImplementationOnce(() => {
        throw new Error("replacement identity changed");
      })
      .mockReturnValue(acceptedProbe);
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(
      (_name, options) => options.beforeProbe?.(1000) === true,
    );
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "SANDBOX  BIND  PORT  PID  STATUS\ndrifted-box  127.0.0.1  18789  12345  running",
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    const result = checkAndRecoverSandboxProcesses("drifted-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      waitForRecreatedSandboxOpenShellReadyImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
    });
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledTimes(3);
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenLastCalledWith(
      "drifted-box",
      "probe",
      15000,
      "replacement-container-id",
    );
    expect(finalize).toHaveBeenCalledWith(true);
    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789", "drifted-box"], {
      ignoreError: true,
      stdio: "ignore",
    });
  });
});
