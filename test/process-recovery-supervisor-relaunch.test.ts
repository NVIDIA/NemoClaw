// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as forwardHealth from "../src/lib/actions/sandbox/forward-health.ts";
import { checkAndRecoverSandboxProcesses } from "../src/lib/actions/sandbox/process-recovery.ts";
import * as openshellRuntime from "../src/lib/adapters/openshell/runtime.ts";
import * as agentRuntime from "../src/lib/agent/runtime.ts";
import * as registry from "../src/lib/state/registry.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockOpenClawSandbox(sandboxName: string) {
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    name: "openclaw",
    displayName: "OpenClaw",
    forwardPort: 18789,
    healthProbe: { url: "http://127.0.0.1:18789/health", port: 18789, timeout_seconds: 30 },
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
    expect(requestGatewaySupervisorAction).toHaveBeenCalledTimes(3);
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

  it("directs a stable no-supervisor result to rebuild when trusted recreation cannot start", () => {
    mockOpenClawSandbox("legacy-box");
    setImmediateRecoveryPolling();
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_NOT_RUNNING",
    }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = checkAndRecoverSandboxProcesses("legacy-box", {
      quiet: false,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: false });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(relaunchManagedSupervisorSessionImpl).toHaveBeenCalledWith(
      "legacy-box",
      expect.objectContaining({ quiet: false }),
    );
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
});
