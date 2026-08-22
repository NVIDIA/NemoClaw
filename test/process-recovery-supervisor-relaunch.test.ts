// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as forwardHealth from "../src/lib/actions/sandbox/forward-health.ts";
import { checkAndRecoverSandboxProcesses } from "../src/lib/actions/sandbox/process-recovery.ts";
import { relaunchManagedSupervisorSession } from "../src/lib/actions/sandbox/supervisor-relaunch.ts";
import * as openshellRuntime from "../src/lib/adapters/openshell/runtime.ts";
import * as agentRuntime from "../src/lib/agent/runtime.ts";
import { finalizeDockerGpuPatchBackup } from "../src/lib/onboard/docker-gpu-patch-finalize.ts";
import * as registry from "../src/lib/state/registry.ts";

const OPENSHELL_RELAY_CHANNEL_DROPPED_STDERR = `Error:   × status: Unavailable, message: "relay
  │ channel dropped", details: [], metadata: MetadataMap { headers: {} }
`;
const ACCEPTED_MANAGED_PROBE = {
  status: 0,
  stdout: "GATEWAY_PID=4242\n",
  stderr: "",
} as const;
const MISSING_MANAGED_SUPERVISOR = {
  status: 1,
  stdout: "",
  stderr: "SUPERVISOR_NOT_RUNNING",
} as const;
function pinnedIdentityRefusal(sandboxName: string) {
  return {
    status: 1,
    stdout: "",
    stderr: `MANAGED_CONTROL_IDENTITY_CHANGED\nOpenShell container identity changed for sandbox '${sandboxName}'; refusing privileged execution against a different container.`,
  } as const;
}

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

function composedRelaunchTransaction(
  order: string[],
  finalizeTransaction: typeof finalizeDockerGpuPatchBackup = vi.fn(
    ({ supervisorReady }: { supervisorReady: boolean }) => {
      order.push(supervisorReady ? "commit-container" : "rollback-container");
      return supervisorReady
        ? { backupRemoved: true, rolledBack: false }
        : { backupRemoved: false, rolledBack: true };
    },
  ),
) {
  const resolveContainer = vi
    .fn()
    .mockReturnValueOnce("old-container-id")
    .mockReturnValue("replacement-container-id");
  const runOpenshell = vi.fn(() => ({ status: 0, stdout: "No sandboxes found.\n" }));
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
          runOpenshell,
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
  return { finalizeTransaction, relaunchManagedSupervisorSessionImpl, runOpenshell };
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
    expect(requestGatewaySupervisorAction).toHaveBeenCalledTimes(11);
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

  it("reports an unconfirmed rollback when recreated gateway health never resolves", () => {
    mockOpenClawSandbox("rejected-box");
    setImmediateRecoveryPolling();
    const finalize = vi.fn(() => ({ backupRemoved: false, rolledBack: false }));
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

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
      recoveryFailureDetail: expect.stringContaining(
        "NemoClaw could not confirm rollback to the previous sandbox container",
      ),
    });
    expect("recoveryFailureDetail" in result ? result.recoveryFailureDetail : "").toContain(
      "the recovered gateway did not become responsive before the recovery timeout",
    );
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
      recoveryFailureDetail: expect.stringContaining(
        "unsafe config path: GATEWAY_UNSAFE_CONFIG_PATH",
      ),
    });
    expect(result).not.toHaveProperty("forwardRecoveryFailed");
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
    const { finalizeTransaction, relaunchManagedSupervisorSessionImpl, runOpenshell } =
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
      expect.objectContaining({
        lifecycleReleaseTimeoutSecs: 900,
        sandboxName: "recovered-box",
        supervisorReady: true,
      }),
      { runOpenshell },
    );
  });

  it("restores the primary dashboard/API host forward after the final legacy container restart (#9364)", () => {
    mockOpenClawSandbox("legacy-handoff-box");
    setImmediateRecoveryPolling();
    const order: string[] = [];
    let forwardStarted = false;
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const finalizeTransaction = vi.fn(
      (
        options: Parameters<typeof finalizeDockerGpuPatchBackup>[0],
        deps: Parameters<typeof finalizeDockerGpuPatchBackup>[1],
      ) => finalizeDockerGpuPatchBackup(options, { ...deps, dockerStop, dockerRm, dockerStart }),
    );
    const { relaunchManagedSupervisorSessionImpl } = composedRelaunchTransaction(
      order,
      finalizeTransaction,
    );
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) =>
      action === "recover" ? { status: 1, stdout: "", stderr: "SUPERVISOR_NOT_RUNNING" } : null,
    );
    const restartedGateway = {
      status: 0,
      stdout: `v1 ${"c".repeat(64)} complete ok 4242 4343\nGATEWAY_PID=4343`,
      stderr: "",
    };
    const requestPinnedGatewaySupervisorAction = vi
      .fn()
      .mockReturnValueOnce(MISSING_MANAGED_SUPERVISOR)
      .mockReturnValueOnce(ACCEPTED_MANAGED_PROBE)
      .mockReturnValueOnce(ACCEPTED_MANAGED_PROBE)
      .mockReturnValueOnce(restartedGateway)
      .mockReturnValueOnce(MISSING_MANAGED_SUPERVISOR)
      .mockReturnValue(ACCEPTED_MANAGED_PROBE);
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(
      (_name: string, options?: { beforeProbe?: (timeoutMs: number) => boolean | null }) =>
        options?.beforeProbe?.(1000) === true,
    );
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => forwardStarted);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation((args) => {
      const responses = {
        "forward list": () => ({
          status: 0,
          output: forwardStarted
            ? "SANDBOX  BIND  PORT  PID  STATUS\nlegacy-handoff-box  127.0.0.1  18789  12345  running"
            : "SANDBOX  BIND  PORT  PID  STATUS",
        }),
      };
      return (
        responses[args.join(" ") as keyof typeof responses]?.() ?? {
          status: 1,
          output: "",
          stdout: "",
          stderr: "unexpected openshell command",
        }
      );
    });
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((args) => {
      forwardStarted ||= args.join(" ") === "forward start --background 18789 legacy-handoff-box";
      return { status: 0 } as never;
    });

    const result = checkAndRecoverSandboxProcesses("legacy-handoff-box", {
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
      forwardRecovered: true,
    });
    expect(dockerStop).toHaveBeenCalledWith(
      "replacement-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerRm).toHaveBeenCalledWith(
      "openshell-recovery-box-nemoclaw-backup",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerStart).toHaveBeenCalledWith(
      "replacement-container-id",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(waitForRecreatedSandboxOpenShellReadyImpl).toHaveBeenCalledTimes(2);
    expect(dockerStart.mock.invocationCallOrder[0]).toBeLessThan(
      waitForRecreatedSandboxOpenShellReadyImpl.mock.invocationCallOrder[1],
    );
    expect(waitForRecreatedSandboxOpenShellReadyImpl.mock.invocationCallOrder[1]).toBeLessThan(
      runOpenshell.mock.invocationCallOrder[0],
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18789", "legacy-handoff-box"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it.each([
    {
      condition: "Docker cannot stop the replacement container",
      finalizeOutcome: () => ({
        backupRemoved: false,
        replacementStoppedForCommit: false,
        rolledBack: false,
        stateRestored: true,
      }),
      expectedDetail: "Docker could not stop the replacement container",
      expectedReadinessCalls: 1,
      finalPinnedAction: () => ACCEPTED_MANAGED_PROBE,
      finalReadinessReady: true,
    },
    {
      condition: "OpenShell does not release the sandbox name",
      finalizeOutcome: () => ({
        backupRemoved: true,
        lifecycleReleaseObserved: false,
        replacementRestarted: false,
        replacementStoppedForCommit: true,
        rolledBack: false,
        stateRestored: true,
      }),
      expectedDetail: "OpenShell did not release the sandbox name",
      expectedReadinessCalls: 1,
      finalPinnedAction: () => ACCEPTED_MANAGED_PROBE,
      finalReadinessReady: true,
    },
    {
      condition: "Docker cannot start the replacement container",
      finalizeOutcome: () => ({
        backupRemoved: true,
        replacementRestarted: false,
        replacementStoppedForCommit: true,
        rolledBack: false,
        stateRestored: true,
      }),
      expectedDetail: "Docker could not start the replacement container",
      expectedReadinessCalls: 1,
      finalPinnedAction: () => ACCEPTED_MANAGED_PROBE,
      finalReadinessReady: true,
    },
    {
      condition: "the final container handoff cannot be confirmed",
      finalizeOutcome: () => {
        throw new Error("final handoff unavailable");
      },
      expectedDetail: "could not confirm the final replacement container handoff",
      expectedReadinessCalls: 1,
      finalPinnedAction: () => ACCEPTED_MANAGED_PROBE,
      finalReadinessReady: true,
    },
    {
      condition: "the final OpenShell readiness check fails",
      finalizeOutcome: () => ({
        backupRemoved: true,
        replacementRestarted: true,
        replacementStoppedForCommit: true,
        rolledBack: false,
        stateRestored: true,
      }),
      expectedDetail: "did not become ready in OpenShell",
      expectedReadinessCalls: 2,
      finalPinnedAction: () => ACCEPTED_MANAGED_PROBE,
      finalReadinessReady: false,
    },
    {
      condition: "the managed supervisor health check does not pass",
      finalizeOutcome: () => ({
        backupRemoved: true,
        replacementRestarted: true,
        replacementStoppedForCommit: true,
        rolledBack: false,
        stateRestored: true,
      }),
      expectedDetail: "managed supervisor health check for the pinned replacement container",
      expectedReadinessCalls: 1,
      finalPinnedAction: () => MISSING_MANAGED_SUPERVISOR,
      finalReadinessReady: true,
    },
    {
      condition: "the pinned container identity changes",
      finalizeOutcome: () => ({
        backupRemoved: true,
        replacementRestarted: true,
        replacementStoppedForCommit: true,
        rolledBack: false,
        stateRestored: true,
      }),
      expectedDetail: "replacement container identity changed",
      expectedReadinessCalls: 1,
      finalPinnedAction: () => pinnedIdentityRefusal("failed-handoff-box"),
      finalReadinessReady: true,
    },
    {
      condition: "the final pinned managed probe throws",
      finalizeOutcome: () => ({
        backupRemoved: true,
        replacementRestarted: true,
        replacementStoppedForCommit: true,
        rolledBack: false,
        stateRestored: true,
      }),
      expectedDetail: "pinned managed supervisor probe could not be completed",
      expectedReadinessCalls: 1,
      finalPinnedAction: () => {
        throw new Error("opaque-pinned-probe-sentinel");
      },
      finalReadinessReady: true,
    },
  ])(
    "does not start the primary dashboard/API host forward when $condition (#9364)",
    ({
      expectedDetail,
      expectedReadinessCalls,
      finalPinnedAction,
      finalReadinessReady,
      finalizeOutcome,
    }) => {
      mockOpenClawSandbox("failed-handoff-box");
      setImmediateRecoveryPolling();
      const finalize = vi.fn((_supervisorReady: boolean) => finalizeOutcome());
      const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
        containerId: "replacement-container-id",
        finalize,
      }));
      const requestGatewaySupervisorAction = vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "SUPERVISOR_NOT_RUNNING",
      }));
      const requestPinnedGatewaySupervisorAction = vi
        .fn()
        .mockReturnValueOnce(ACCEPTED_MANAGED_PROBE)
        .mockReturnValueOnce(ACCEPTED_MANAGED_PROBE)
        .mockImplementation(finalPinnedAction);
      const waitForRecreatedSandboxOpenShellReadyImpl = vi
        .fn()
        .mockImplementationOnce(
          (_name: string, options?: { beforeProbe?: (timeoutMs: number) => boolean | null }) =>
            options?.beforeProbe?.(1000) === true,
        )
        .mockImplementation(
          (_name: string, options?: { beforeProbe?: (timeoutMs: number) => boolean | null }) =>
            options?.beforeProbe?.(1000) === true && finalReadinessReady,
        );
      const captureOpenshell = vi
        .spyOn(openshellRuntime, "captureOpenshell")
        .mockReturnValue({ status: 0, output: "" });
      const runOpenshell = vi
        .spyOn(openshellRuntime, "runOpenshell")
        .mockReturnValue({ status: 0 } as never);

      const result = checkAndRecoverSandboxProcesses("failed-handoff-box", {
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
        recoveryFailureDetail: expect.stringContaining(expectedDetail),
      });
      expect("recoveryFailureDetail" in result ? result.recoveryFailureDetail : "").not.toContain(
        "opaque-",
      );
      expect(result).not.toHaveProperty("forwardRecoveryFailed");
      expect(finalize).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledWith(true);
      expect(waitForRecreatedSandboxOpenShellReadyImpl).toHaveBeenCalledTimes(
        expectedReadinessCalls,
      );
      expect(captureOpenshell).not.toHaveBeenCalled();
      expect(runOpenshell).not.toHaveBeenCalled();
    },
  );

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
      recoveryFailureDetail: "Sandbox recovery did not complete; the previous container was restored",
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
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "" });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

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
      recoveryFailureDetail:
        "Sandbox recovery did not complete; the previous container was restored",
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
    expect(captureOpenshell).not.toHaveBeenCalled();
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
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "" });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

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
      recoveryFailureDetail:
        "Sandbox recovery failed and the previous container could not be restored automatically",
    });
    expect(result).not.toHaveProperty("forwardRecoveryFailed");
    expect(captureOpenshell).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
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
    const finalize = vi.fn(() => ({
      backupRemoved: false,
      rolledBack: true,
      stateRestored: false,
    }));
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
      recoveryFailureDetail: expect.stringContaining("did not become ready in OpenShell"),
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

  it.each([
    {
      condition: "the rollback reports failure",
      finalizeOutcome: () => ({
        backupRemoved: false,
        rolledBack: false,
        stateRestored: false,
      }),
    },
    {
      condition: "the rollback throws",
      finalizeOutcome: () => {
        throw new Error("opaque-finalizer-sentinel");
      },
    },
  ])("reports the readiness failure and unconfirmed rollback when $condition (#9364)", ({
    finalizeOutcome,
  }) => {
    mockOpenClawSandbox("rollback-box");
    setImmediateRecoveryPolling();
    const finalize = vi.fn((_supervisorReady: boolean) => finalizeOutcome());
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn(() => MISSING_MANAGED_SUPERVISOR);
    const requestPinnedGatewaySupervisorAction = vi.fn(() => ACCEPTED_MANAGED_PROBE);
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(() => false);
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "" });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    const result = checkAndRecoverSandboxProcesses("rollback-box", {
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
      recoveryFailureDetail: expect.stringContaining(
        "NemoClaw could not confirm rollback to the previous sandbox container",
      ),
    });
    expect("recoveryFailureDetail" in result ? result.recoveryFailureDetail : "").toContain(
      "did not become ready in OpenShell",
    );
    expect("recoveryFailureDetail" in result ? result.recoveryFailureDetail : "").not.toContain(
      "opaque-finalizer-sentinel",
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(false);
    expect(captureOpenshell).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reports the last structured OpenShell error when readiness times out", () => {
    mockOpenClawSandbox("relay-dropped-box");
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
      recoveryFailureDetail: expect.stringContaining(
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
    const finalize = vi.fn(() => ({
      backupRemoved: false,
      rolledBack: true,
      stateRestored: false,
    }));
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
      recoveryFailureDetail: expect.stringContaining(
        "managed supervisor health check for the pinned replacement container did not pass",
      ),
    });
    expect("recoveryFailureDetail" in result ? result.recoveryFailureDetail : "").toContain(
      "unsafe config path: GATEWAY_UNSAFE_CONFIG_PATH",
    );
    expect(finalize).toHaveBeenCalledWith(false);
    expect(captureOpenshell).not.toHaveBeenCalled();
  });

  it.each([
    {
      condition: "the replacement identity changes after readiness",
      expectedDetail: "replacement container identity changed",
      finalProbe: () => pinnedIdentityRefusal("drifted-box"),
    },
    {
      condition: "the final managed supervisor health check is rejected",
      expectedDetail: "unsafe config path: GATEWAY_UNSAFE_CONFIG_PATH",
      finalProbe: () => ({
        status: 1,
        stdout: "",
        stderr: "GATEWAY_UNSAFE_CONFIG_PATH",
      }),
    },
    {
      condition: "the final pinned managed probe throws",
      expectedDetail: "pinned managed supervisor probe could not be completed",
      finalProbe: () => {
        throw new Error("opaque-forward-probe-sentinel");
      },
    },
  ])("rejects a healthy forward when $condition (#9364)", ({ expectedDetail, finalProbe }) => {
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
      .mockImplementationOnce(finalProbe)
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
    const probeTiming = {
      measure: <T>(_stage: "processes" | "forward", operation: () => T): T => operation(),
      setForwardAction: vi.fn(),
    };

    const result = checkAndRecoverSandboxProcesses("drifted-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      waitForRecreatedSandboxOpenShellReadyImpl,
      probeTiming,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
      recoveryFailureDetail: expect.stringContaining(expectedDetail),
    });
    expect("recoveryFailureDetail" in result ? result.recoveryFailureDetail : "").not.toContain(
      "opaque-",
    );
    expect(result).not.toHaveProperty("forwardRecoveryFailed");
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledTimes(3);
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenLastCalledWith(
      "drifted-box",
      "probe",
      15000,
      "replacement-container-id",
    );
    expect(finalize).toHaveBeenCalledWith(true);
    expect(probeTiming.setForwardAction).toHaveBeenCalledOnce();
    expect(probeTiming.setForwardAction).toHaveBeenCalledWith("failed");
    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789", "drifted-box"], {
      ignoreError: true,
      stdio: "ignore",
    });
  });

  it("reports GATEWAY_UNSAFE_CONFIG_PATH after a transient identity refusal clears (#9364)", () => {
    mockOpenClawSandbox("current-probe-box");
    setImmediateRecoveryPolling();
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "1");
    const finalize = vi.fn(() => ({ backupRemoved: true, rolledBack: false }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn(() => MISSING_MANAGED_SUPERVISOR);
    const unsafeConfigProbe = {
      status: 1,
      stdout: "",
      stderr: "GATEWAY_UNSAFE_CONFIG_PATH",
    } as const;
    const requestPinnedGatewaySupervisorAction = vi
      .fn()
      .mockReturnValueOnce(pinnedIdentityRefusal("current-probe-box"))
      .mockReturnValueOnce(ACCEPTED_MANAGED_PROBE)
      .mockReturnValueOnce(ACCEPTED_MANAGED_PROBE)
      .mockReturnValue(unsafeConfigProbe);
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(
      (_name, options) => options.beforeProbe?.(1000) === true,
    );
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output:
        "SANDBOX  BIND  PORT  PID  STATUS\ncurrent-probe-box  127.0.0.1  18789  12345  running",
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    const result = checkAndRecoverSandboxProcesses("current-probe-box", {
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
      recoveryFailureDetail: expect.stringContaining(
        "unsafe config path: GATEWAY_UNSAFE_CONFIG_PATH",
      ),
    });
    expect("recoveryFailureDetail" in result ? result.recoveryFailureDetail : "").not.toContain(
      "identity changed",
    );
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledTimes(4);
    expect(finalize).toHaveBeenCalledWith(true);
    expect(runOpenshell).toHaveBeenCalledOnce();
  });
});
