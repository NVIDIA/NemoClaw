// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as agentRuntime from "../../agent/runtime";
import * as registry from "../../state/registry";
import * as forwardHealth from "./forward-health";
import { checkAndRecoverSandboxProcesses } from "./process-recovery";

const forwardMocks = vi.hoisted(() => ({
  controller: {
    ensure: vi.fn(() => ({ action: "started", receipt: {} })),
    inspect: vi.fn(() => ({
      disposition: "absent",
      ownsListener: false,
      reachable: false,
      receipt: null,
    })),
    stop: vi.fn(() => "absent"),
    stopAll: vi.fn(() => 0),
    stopPort: vi.fn(() => "absent"),
  },
}));

vi.mock("../../adapters/openshell/forward-service-controller", () => ({
  createForwardServiceController: () => forwardMocks.controller,
}));

vi.mock("../../onboard/forward-service-migration", () => ({
  requireProductionForwardServiceAuthority: (sandboxName: string) => ({
    authority: {
      gatewayName: "nemoclaw",
      sandboxIdentityFingerprint: "a".repeat(64),
      sandboxName,
    },
    migrated: false,
    assertCurrent: vi.fn(),
    assertLiveCurrent: vi.fn(),
  }),
  retireProductionLegacySandboxForwards: vi.fn(() => 0),
}));

const ACCEPTED_MANAGED_RECOVERY = {
  status: 0,
  stdout: `v1 ${"a".repeat(64)} complete ok 0 4242\nGATEWAY_PID=4242`,
  stderr: "",
} as const;

function mockOpenClawSandbox(sandboxName: string): void {
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    name: "openclaw",
    displayName: "OpenClaw",
    forwardPort: 18789,
    healthProbe: {
      url: "http://127.0.0.1:18789/health",
      port: 18789,
      timeout_seconds: 30,
    },
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: sandboxName,
    agent: "openclaw",
    dashboardPort: 18789,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "startup-generation",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    openshellDriver: "docker",
  });
}

function mockRecoveredForward(sandboxName: string): void {
  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
  vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
    status: 0,
    output: `SANDBOX  BIND  PORT  PID  STATUS\n${sandboxName}  127.0.0.1  18789  12345  running`,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("checkAndRecoverSandboxProcesses managed startup", () => {
  it.each([
    "SUPERVISOR_NOT_RUNNING",
    "SUPERVISOR_DISCOVERY_PENDING",
    "PRIVILEGED_CONTROL_UNAVAILABLE",
    "GATEWAY_HEALTH_TIMEOUT",
  ])("waits through the exact %s startup transition (#9466)", (startupMarker) => {
    const sandboxName = "startup-box";
    mockOpenClawSandbox(sandboxName);
    mockRecoveredForward(sandboxName);
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
    const requestGatewaySupervisorAction = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: startupMarker })
      .mockReturnValueOnce(ACCEPTED_MANAGED_RECOVERY);
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);

    const result = checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      waitForRecreatedSandboxOpenShellReadyImpl: () => true,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: true,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledTimes(2);
    expect(relaunchManagedSupervisorSessionImpl).not.toHaveBeenCalled();
  });

  it("does not retry a diagnostic-bearing supervisor-discovery result", () => {
    const sandboxName = "diagnostic-start";
    mockOpenClawSandbox(sandboxName);
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_DISCOVERY_PENDING\nunexpected diagnostic",
    }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);

    const result = checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(relaunchManagedSupervisorSessionImpl).not.toHaveBeenCalled();
  });

  it("does not retry a managed-container identity mismatch (#9466)", () => {
    const sandboxName = "identity-box";
    mockOpenClawSandbox(sandboxName);
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr:
        `PRIVILEGED_CONTROL_UNAVAILABLE: OpenShell container identity changed for sandbox ` +
        `'${sandboxName}'; refusing privileged execution against a different container.`,
    }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);

    const result = checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(relaunchManagedSupervisorSessionImpl).not.toHaveBeenCalled();
  });
});
