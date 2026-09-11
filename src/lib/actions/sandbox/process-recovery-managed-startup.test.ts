// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as forwardService from "../../adapters/openshell/forward-service";
import * as openshellResolve from "../../adapters/openshell/resolve";
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

const PENDING_MANAGED_CONTAINER_DISCOVERY = {
  status: 1,
  stdout: "",
  stderr: "PRIVILEGED_CONTROL_UNAVAILABLE",
  managedContainerDiscoveryUnavailable: true,
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
  vi.spyOn(forwardService, "isForwardServiceListenerOwner").mockReturnValue(true);
  vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
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
    ["SUPERVISOR_NOT_RUNNING", false],
    ["SUPERVISOR_DISCOVERY_PENDING", false],
    ["PRIVILEGED_CONTROL_UNAVAILABLE", true],
    ["GATEWAY_HEALTH_TIMEOUT", false],
  ] as const)(
    "waits through the exact %s startup transition (#9466)",
    async (startupMarker, discovery) => {
      const sandboxName = "startup-box";
      mockGatewaySandbox(sandboxName);
      mockRecoveredForward(sandboxName);
      vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
      vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
      const requestGatewaySupervisorAction = vi
        .fn()
        .mockReturnValueOnce({
          status: 1,
          stdout: "",
          stderr: startupMarker,
          ...(discovery ? { managedContainerDiscoveryUnavailable: true as const } : {}),
        })
        .mockReturnValueOnce(ACCEPTED_MANAGED_RECOVERY);
      const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);

      const result = await checkAndRecoverSandboxProcesses(sandboxName, {
        quiet: true,
        isSandboxGatewayRunningImpl: async () => false,
        requestGatewaySupervisorAction,
        relaunchManagedSupervisorSessionImpl,
        waitForRecreatedSandboxOpenShellReadyImpl: async () => true,
      });

      expect(result).toMatchObject({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      });
      expect(requestGatewaySupervisorAction).toHaveBeenCalledTimes(2);
      expect(relaunchManagedSupervisorSessionImpl).not.toHaveBeenCalled();
    },
  );

  it("does not retry a diagnostic-bearing supervisor-discovery result", async () => {
    const sandboxName = "diagnostic-start";
    mockGatewaySandbox(sandboxName);
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_DISCOVERY_PENDING\nunexpected diagnostic",
    }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => null);

    const result = await checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: async () => false,
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

  it("does not retry a managed-container identity mismatch (#9466)", async () => {
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

    const result = await checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: async () => false,
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

  it("shares one deadline across managed recovery controller calls (#11107)", async () => {
    const sandboxName = "deadline-box";
    mockGatewaySandbox(sandboxName);
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "3");
    let now = 0;
    vi.spyOn(wait, "sleepSeconds").mockImplementation((seconds) => {
      now += seconds * 1000;
    });
    const timeouts: number[] = [];
    const requestGatewaySupervisorAction = vi.fn(
      (_name: string, _action: "restart" | "recover" | "probe", timeout = 210_000) => {
        timeouts.push(timeout);
        now += Math.min(timeout, 12_000);
        return PENDING_MANAGED_CONTAINER_DISCOVERY;
      },
    );
    const onRecoveryFailureLayer = vi.fn();

    const result = await checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: async () => false,
      managedControlNowImpl: () => now,
      managedControlTimeoutMs: 20_000,
      onRecoveryFailureLayer,
      requestGatewaySupervisorAction,
    });

    expect(result.recovered).toBe(false);
    expect(timeouts).toEqual([20_000, 5_000]);
    expect(onRecoveryFailureLayer).toHaveBeenCalledWith(
      "health timeout",
      "managed gateway recovery exceeded its 20-second total deadline",
    );
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
          seconds >= readyAt ? ACCEPTED_MANAGED_RECOVERY : PENDING_MANAGED_CONTAINER_DISCOVERY,
      });
      expect({ ready: result, elapsed: seconds }).toEqual({ ready, elapsed });
    },
  );

  it.each([
    { stdout: "", stderr: "PRIVILEGED_CONTROL_UNAVAILABLE" },
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
          ? PENDING_MANAGED_CONTAINER_DISCOVERY.stderr
          : "PRIVILEGED_CONTROL_UNAVAILABLE: container identity changed",
      ...(seconds < 42 ? { managedContainerDiscoveryUnavailable: true as const } : {}),
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
                stderr:
                  seconds < 36
                    ? PENDING_MANAGED_CONTAINER_DISCOVERY.stderr
                    : "GATEWAY_HEALTH_TIMEOUT",
                ...(seconds < 36 ? { managedContainerDiscoveryUnavailable: true as const } : {}),
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
          stderr:
            ++calls % 3 === 0
              ? "GATEWAY_HEALTH_TIMEOUT"
              : PENDING_MANAGED_CONTAINER_DISCOVERY.stderr,
          ...(calls % 3 === 0 ? {} : { managedContainerDiscoveryUnavailable: true as const }),
        }),
      }),
    ).toBe(false);
    expect({ calls, seconds }).toEqual({ calls: 31, seconds: 90 });
  });

  it("waits through supervisor startup before recreation after delayed discovery (#11107)", async () => {
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
    const result = await checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: async () => false,
      requestGatewaySupervisorAction: () => ({
        status: 1,
        stdout: "",
        stderr:
          seconds < 36 ? PENDING_MANAGED_CONTAINER_DISCOVERY.stderr : "SUPERVISOR_NOT_RUNNING",
        ...(seconds < 36 ? { managedContainerDiscoveryUnavailable: true as const } : {}),
      }),
      relaunchManagedSupervisorSessionImpl: relaunch,
    });
    expect(result.recovered).toBe(false);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("honors an explicit shorter discovery bound (#11107)", () => {
    const request = vi.fn(() => ({
      ...PENDING_MANAGED_CONTAINER_DISCOVERY,
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
    async ({ readyAt, recovered, elapsed }) => {
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
      const result = await checkAndRecoverSandboxProcesses(sandboxName, {
        quiet: true,
        isSandboxGatewayRunningImpl: async () => false,
        requestGatewaySupervisorAction: () =>
          seconds >= readyAt ? ACCEPTED_MANAGED_RECOVERY : PENDING_MANAGED_CONTAINER_DISCOVERY,
        relaunchManagedSupervisorSessionImpl: relaunch,
        waitForRecreatedSandboxOpenShellReadyImpl: async () => true,
      });
      expect({ recovered: result.recovered, elapsed: seconds }).toEqual({ recovered, elapsed });
      expect(relaunch).not.toHaveBeenCalled();
    },
  );
});
