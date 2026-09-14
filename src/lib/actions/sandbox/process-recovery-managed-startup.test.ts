// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as forwardService from "../../adapters/openshell/forward-service";
import * as openshellResolve from "../../adapters/openshell/resolve";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as agentRuntime from "../../agent/runtime";
import * as wait from "../../core/wait";
import * as gatewayTeardownAuthority from "../../onboard/gateway-teardown-authority";
import * as registry from "../../state/registry";
import * as privilegedExec from "../../sandbox/privileged-exec";
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
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayForwardAuthority").mockImplementation(
    ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  );
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
  it("does not fall back to Docker when scoped Hermes receipt control is absent", async () => {
    mockGatewaySandbox("fresh-hermes", "hermes");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(privilegedExec, "executePortableGatewaySupervisorAction").mockResolvedValue(null);
    const discover = vi.spyOn(privilegedExec, "resolvePrivilegedSandboxTarget");
    await expect(
      checkAndRecoverSandboxProcesses("fresh-hermes", {
        portableSupervisorEnvironment: { HOME: "/home/kiosk" },
        isSandboxGatewayRunningImpl: async () => true,
      }),
    ).resolves.toMatchObject({ secretBoundaryRefused: true });
    expect(discover).not.toHaveBeenCalled();
  });
  it("rejects a portable supervisor environment for a selected remote runtime", async () => {
    const request = vi.spyOn(privilegedExec, "executePortableGatewaySupervisorAction");
    await expect(
      checkAndRecoverSandboxProcesses("remote-hermes", {
        portableSupervisorEnvironment: { HOME: "/home/kiosk" },
        runtimeSelection: { gatewayName: "remote", workspace: "default" },
      }),
    ).rejects.toThrow("cannot control a selected remote runtime");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses the onboarding environment for Hermes control and preserves validator refusal", async () => {
    mockGatewaySandbox("fresh-hermes", "hermes");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = vi
      .spyOn(privilegedExec, "executePortableGatewaySupervisorAction")
      .mockResolvedValue({
        status: 1,
        stdout: "",
        stderr: "SECRET_BOUNDARY_REFUSED",
      });
    const environment = { HOME: "/home/kiosk", PATH: "/usr/bin" };
    await expect(
      checkAndRecoverSandboxProcesses("fresh-hermes", {
        quiet: true,
        portableSupervisorEnvironment: environment,
        isSandboxGatewayRunningImpl: async () => true,
      }),
    ).resolves.toMatchObject({
      checked: true,
      secretBoundaryRefused: true,
      secretBoundaryReason: "raw-secret",
    });
    expect(request).toHaveBeenCalledWith(
      "fresh-hermes",
      expect.objectContaining({ action: "recover" }),
      environment,
    );
  });
  it("recovers a portable gateway and rechecks it through the same scoped control path", async () => {
    mockGatewaySandbox("fresh-hermes", "hermes");
    mockRecoveredForward("fresh-hermes");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0.001");
    vi.spyOn(wait, "sleepSeconds").mockImplementation(() => undefined);
    const request = vi
      .spyOn(privilegedExec, "executePortableGatewaySupervisorAction")
      .mockResolvedValue(ACCEPTED_MANAGED_RECOVERY);
    const discover = vi
      .spyOn(privilegedExec, "resolvePrivilegedSandboxTarget")
      .mockImplementation(() => {
        throw new Error("unexpected Docker discovery");
      });
    const environment = { HOME: "/home/kiosk" };
    await expect(
      checkAndRecoverSandboxProcesses("fresh-hermes", {
        quiet: true,
        portableSupervisorEnvironment: environment,
        isSandboxGatewayRunningImpl: async () => false,
        waitForRecreatedSandboxOpenShellReadyImpl: async () => true,
      }),
    ).resolves.toMatchObject({ checked: true, wasRunning: false, recovered: true });
    const actions = request.mock.calls.map(([, request]) => request.action);
    expect(actions[0]).toBe("recover");
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions.slice(1).every((action) => action === "probe")).toBe(true);
    expect(request.mock.calls.every(([, , env]) => env === environment)).toBe(true);
    expect(discover).not.toHaveBeenCalled();
  });

  it("awaits an injected asynchronous recovery request and its settle probes", async () => {
    mockGatewaySandbox("async-gateway");
    mockRecoveredForward("async-gateway");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0.001");
    vi.spyOn(wait, "sleepSeconds").mockImplementation(() => undefined);
    const request = vi.fn(
      async (_name: string, _action: "restart" | "recover" | "probe") => ACCEPTED_MANAGED_RECOVERY,
    );
    const portableRequest = vi.spyOn(privilegedExec, "executePortableGatewaySupervisorAction");
    const discover = vi.spyOn(privilegedExec, "resolvePrivilegedSandboxTarget");
    await expect(
      checkAndRecoverSandboxProcesses("async-gateway", {
        quiet: true,
        requestGatewaySupervisorAction: request,
        isSandboxGatewayRunningImpl: async () => false,
        waitForRecreatedSandboxOpenShellReadyImpl: async () => true,
      }),
    ).resolves.toMatchObject({ checked: true, wasRunning: false, recovered: true });
    const actions = request.mock.calls.map(([, action]) => action);
    expect(actions[0]).toBe("recover");
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions.slice(1).every((action) => action === "probe")).toBe(true);
    expect(portableRequest).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it.each(["missing supervisor", "authority rejection", "spawn error"])(
    "refuses portable %s without Docker discovery or supervisor relaunch",
    async (failure) => {
      mockGatewaySandbox("fresh-hermes", "hermes");
      vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
      const outcomes = {
        "missing supervisor": async () => ({
          status: 1,
          stdout: "",
          stderr: "SUPERVISOR_NOT_RUNNING",
        }),
        "authority rejection": async () => {
          throw new Error("untrusted diagnostic");
        },
        "spawn error": async () => ({
          ...ACCEPTED_MANAGED_RECOVERY,
          error: new Error("spawn failed"),
        }),
      };
      vi.spyOn(privilegedExec, "executePortableGatewaySupervisorAction").mockImplementation(
        outcomes[failure as keyof typeof outcomes],
      );
      const discover = vi.spyOn(privilegedExec, "resolvePrivilegedSandboxTarget");
      const relaunch = vi.fn(() => null);
      await expect(
        checkAndRecoverSandboxProcesses("fresh-hermes", {
          quiet: true,
          portableSupervisorEnvironment: { HOME: "/home/kiosk" },
          isSandboxGatewayRunningImpl: async () => false,
          relaunchManagedSupervisorSessionImpl: relaunch,
        }),
      ).resolves.toMatchObject({ wasRunning: false, recovered: false });
      expect(discover).not.toHaveBeenCalled();
      expect(relaunch).not.toHaveBeenCalled();
    },
  );

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
      const result = await checkAndRecoverSandboxProcesses(sandboxName, {
        quiet: true,
        isSandboxGatewayRunningImpl: async () => false,
        requestGatewaySupervisorAction,
        waitForRecreatedSandboxOpenShellReadyImpl: async () => true,
      });

      expect(result).toMatchObject({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      });
      expect(requestGatewaySupervisorAction).toHaveBeenCalledTimes(2);
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
    const result = await checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: async () => false,
      requestGatewaySupervisorAction,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
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
    const result = await checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      isSandboxGatewayRunningImpl: async () => false,
      requestGatewaySupervisorAction,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
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

  it("stops after delayed discovery proves the native supervisor is absent (#11107)", async () => {
    const sandboxName = "hermes-discovery";
    mockGatewaySandbox(sandboxName, "hermes");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "3");
    let seconds = 0;
    vi.spyOn(wait, "sleepSeconds").mockImplementation((duration) => {
      seconds += duration;
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
    });
    expect(result.recovered).toBe(false);
    expect(seconds).toBe(66);
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
      const result = await checkAndRecoverSandboxProcesses(sandboxName, {
        quiet: true,
        isSandboxGatewayRunningImpl: async () => false,
        requestGatewaySupervisorAction: () =>
          seconds >= readyAt ? ACCEPTED_MANAGED_RECOVERY : PENDING_MANAGED_CONTAINER_DISCOVERY,
        waitForRecreatedSandboxOpenShellReadyImpl: async () => true,
      });
      expect({ recovered: result.recovered, elapsed: seconds }).toEqual({ recovered, elapsed });
    },
  );
});
