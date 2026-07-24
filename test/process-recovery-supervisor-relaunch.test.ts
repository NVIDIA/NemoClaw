// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as forwardHealth from "../src/lib/actions/sandbox/forward-health.ts";
import { checkAndRecoverSandboxProcesses } from "../src/lib/actions/sandbox/process-recovery.ts";
import { relaunchManagedSupervisorSession } from "../src/lib/actions/sandbox/supervisor-relaunch.ts";
import * as openshellRuntime from "../src/lib/adapters/openshell/runtime.ts";
import * as agentRuntime from "../src/lib/agent/runtime.ts";
import * as registry from "../src/lib/state/registry.ts";

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

describe("checkAndRecoverSandboxProcesses supervisor relaunch", () => {
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

  it("commits only after managed health accepts the recreated supervisor", () => {
    mockOpenClawSandbox("recovered-box");
    setImmediateRecoveryPolling();
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
    const requestPinnedGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));
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
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledWith(
      "recovered-box",
      "probe",
      210000,
      "replacement-container-id",
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(true);
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

  it("uses the sandbox readiness budget after a longer gateway health wait (#7273)", () => {
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
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(() => false);
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
      recovered: true,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail: expect.stringContaining("did not become ready in OpenShell"),
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(true);
    expect(waitForRecreatedSandboxOpenShellReadyImpl).toHaveBeenCalledWith(
      "unready-box",
      expect.objectContaining({ beforeProbe: expect.any(Function), timeoutSeconds: 180 }),
    );
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
        stderr: "SUPERVISOR_UNAVAILABLE",
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
      recovered: true,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail: expect.stringContaining("failed the managed health guard"),
    });
    expect(finalize).toHaveBeenCalledWith(true);
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
