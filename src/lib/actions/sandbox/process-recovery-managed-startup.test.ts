// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as agentRuntime from "../../agent/runtime";
import * as wait from "../../core/wait";
import * as registry from "../../state/registry";
import * as forwardHealth from "./forward-health";
import {
  checkAndRecoverSandboxProcesses,
  waitForManagedGatewaySupervisor,
} from "./process-recovery";

const ACCEPTED_MANAGED_RECOVERY = {
  status: 0,
  stdout: `v1 ${"a".repeat(64)} complete ok 0 4242\nGATEWAY_PID=4242`,
  stderr: "",
} as const;

function mockGatewaySandbox(sandboxName: string, agent: "openclaw" | "hermes" = "openclaw"): void {
  const port = agent === "hermes" ? 8642 : 18789;
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    name: agent,
    displayName: agent === "hermes" ? "Hermes Agent" : "OpenClaw",
    forwardPort: port,
    healthProbe: {
      url: `http://127.0.0.1:${port}/health`,
      port,
      timeout_seconds: 30,
    },
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: sandboxName,
    agent,
    dashboardPort: port,
    openshellDriver: "docker",
  });
}

function mockRecoveredForward(_sandboxName: string): void {
  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
  vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
    status: 0,
    output: "SANDBOX  BIND  PORT  PID  STATUS",
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
    mockGatewaySandbox(sandboxName);
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
    mockGatewaySandbox(sandboxName);
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
    mockGatewaySandbox(sandboxName);
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

describe("managed container discovery settlement", () => {
  it.each([
    { readyAt: 0, ready: true, elapsed: 0 },
    { readyAt: 42, ready: true, elapsed: 42 },
    { readyAt: 60, ready: true, elapsed: 60 },
    { readyAt: 63, ready: false, elapsed: 60 },
  ])(
    "ends at $elapsed seconds when discovery needs $readyAt seconds (#11107)",
    ({ readyAt, ready, elapsed }) => {
      let seconds = 0;
      const result = waitForManagedGatewaySupervisor("discovery-box", {
        sleepImpl: (duration) => {
          seconds += duration;
        },
        requestGatewaySupervisorActionImpl: () =>
          seconds >= readyAt
            ? ACCEPTED_MANAGED_RECOVERY
            : { status: 1, stdout: "", stderr: "PRIVILEGED_CONTROL_UNAVAILABLE" },
      });
      expect({ ready: result, elapsed: seconds }).toEqual({ ready, elapsed });
    },
  );

  it.each([
    { stdout: "", stderr: "PRIVILEGED_CONTROL_UNAVAILABLE: identity mismatch" },
    { stdout: "", stderr: "PRIVILEGED_CONTROL_UNAVAILABLE\nunexpected diagnostic" },
    { stdout: "unexpected output", stderr: "PRIVILEGED_CONTROL_UNAVAILABLE" },
    { stdout: "", stderr: "SUPERVISOR_UNAVAILABLE" },
  ])("refuses diagnostic-bearing discovery without waiting (#11107)", ({ stdout, stderr }) => {
    const sleep = vi.fn();
    const request = vi.fn(() => ({ status: 1, stdout, stderr }));
    expect(
      waitForManagedGatewaySupervisor("discovery-box", {
        sleepImpl: sleep,
        requestGatewaySupervisorActionImpl: request,
      }),
    ).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps the original bound for other startup markers (#11107)", () => {
    let seconds = 0;
    expect(
      waitForManagedGatewaySupervisor("discovery-box", {
        sleepImpl: (duration) => {
          seconds += duration;
        },
        requestGatewaySupervisorActionImpl: () => ({
          status: 1,
          stdout: "",
          stderr: "GATEWAY_HEALTH_TIMEOUT",
        }),
      }),
    ).toBe(false);
    expect(seconds).toBe(30);
  });

  it("stops on an identity refusal after delayed discovery (#11107)", () => {
    let seconds = 0;
    const request = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr:
        seconds < 42
          ? "PRIVILEGED_CONTROL_UNAVAILABLE"
          : "PRIVILEGED_CONTROL_UNAVAILABLE: container identity changed",
    }));
    expect(
      waitForManagedGatewaySupervisor("discovery-box", {
        sleepImpl: (duration) => {
          seconds += duration;
        },
        requestGatewaySupervisorActionImpl: request,
      }),
    ).toBe(false);
    expect(seconds).toBe(42);
    expect(request).toHaveBeenCalledTimes(15);
  });

  it("preserves startup retries after delayed discovery (#11107)", () => {
    let seconds = 0;
    expect(
      waitForManagedGatewaySupervisor("discovery-box", {
        sleepImpl: (duration) => {
          seconds += duration;
        },
        requestGatewaySupervisorActionImpl: () =>
          seconds >= 48
            ? ACCEPTED_MANAGED_RECOVERY
            : {
                status: 1,
                stdout: "",
                stderr: seconds < 36 ? "PRIVILEGED_CONTROL_UNAVAILABLE" : "GATEWAY_HEALTH_TIMEOUT",
              },
      }),
    ).toBe(true);
    expect(seconds).toBe(48);
  });

  it("bounds alternating discovery and startup failures (#11107)", () => {
    let calls = 0;
    let seconds = 0;
    expect(
      waitForManagedGatewaySupervisor("discovery-box", {
        sleepImpl: (duration) => {
          seconds += duration;
        },
        requestGatewaySupervisorActionImpl: () => ({
          status: 1,
          stdout: "",
          stderr: ++calls % 3 === 0 ? "GATEWAY_HEALTH_TIMEOUT" : "PRIVILEGED_CONTROL_UNAVAILABLE",
        }),
      }),
    ).toBe(false);
    expect({ calls, seconds }).toEqual({ calls: 31, seconds: 90 });
  });

  it("waits through supervisor startup before recreation after delayed discovery (#11107)", () => {
    const sandboxName = "hermes-discovery";
    mockGatewaySandbox(sandboxName, "hermes");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "3");
    let seconds = 0;
    vi.spyOn(wait, "sleepSeconds").mockImplementation((duration) => {
      seconds += duration;
    });
    const relaunch = vi.fn(() => {
      expect(seconds).toBe(66);
      return null;
    });
    const result = checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction: () => ({
        status: 1,
        stdout: "",
        stderr: seconds < 36 ? "PRIVILEGED_CONTROL_UNAVAILABLE" : "SUPERVISOR_NOT_RUNNING",
      }),
      relaunchManagedSupervisorSessionImpl: relaunch,
    });
    expect(result.recovered).toBe(false);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("honors an explicit shorter discovery bound (#11107)", () => {
    const request = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "PRIVILEGED_CONTROL_UNAVAILABLE",
    }));
    expect(
      waitForManagedGatewaySupervisor("discovery-box", {
        maxAttempts: 2,
        sleepImpl: () => {},
        requestGatewaySupervisorActionImpl: request,
      }),
    ).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { readyAt: 42, recovered: true, elapsed: 42 },
    { readyAt: 63, recovered: false, elapsed: 60 },
  ])(
    "ends Hermes recovery at $elapsed seconds when discovery needs $readyAt seconds (#11107)",
    ({ readyAt, recovered, elapsed }) => {
      const sandboxName = "hermes-discovery";
      mockGatewaySandbox(sandboxName, "hermes");
      mockRecoveredForward(sandboxName);
      vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "3");
      vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
      let seconds = 0;
      vi.spyOn(wait, "sleepSeconds").mockImplementation((duration) => {
        seconds += duration;
      });
      const relaunch = vi.fn(() => null);
      const result = checkAndRecoverSandboxProcesses(sandboxName, {
        quiet: true,
        isSandboxGatewayRunningImpl: () => false,
        requestGatewaySupervisorAction: () =>
          seconds >= readyAt
            ? ACCEPTED_MANAGED_RECOVERY
            : { status: 1, stdout: "", stderr: "PRIVILEGED_CONTROL_UNAVAILABLE" },
        relaunchManagedSupervisorSessionImpl: relaunch,
        waitForRecreatedSandboxOpenShellReadyImpl: () => true,
      });
      expect({ recovered: result.recovered, elapsed: seconds }).toEqual({ recovered, elapsed });
      expect(relaunch).not.toHaveBeenCalled();
    },
  );
});
