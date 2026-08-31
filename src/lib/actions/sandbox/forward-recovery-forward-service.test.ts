// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  controller: {
    ensure: vi.fn(),
    inspect: vi.fn(),
    stop: vi.fn(),
    stopPort: vi.fn(),
    stopAll: vi.fn(),
  },
  getRegisteredAgent: vi.fn(),
  getSandbox: vi.fn(),
  getSessionAgent: vi.fn(),
  isLocalForwardReachable: vi.fn(),
  runOpenshell: vi.fn(),
}));

vi.mock("../../adapters/openshell/forward-service-controller", () => ({
  createForwardServiceController: () => mocks.controller,
}));

vi.mock("../../adapters/openshell/resolve", () => ({
  resolveOpenshell: () => "/usr/local/bin/openshell",
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  createForwardServiceController: () => mocks.controller,
  isCommandTimeout: () => false,
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("../../agent/runtime", () => ({
  getRegisteredAgent: mocks.getRegisteredAgent,
  getSessionAgent: mocks.getSessionAgent,
  hasGatewayRuntime: () => true,
}));

vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
}));

vi.mock("./forward-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./forward-health")>()),
  isLocalForwardReachable: mocks.isLocalForwardReachable,
}));

vi.mock("./hermes-dashboard-recovery", () => ({
  ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
  getHermesDashboardRecoveryConfig: vi.fn(() => null),
}));

const FINGERPRINT = "a".repeat(64);
const SANDBOX = {
  agent: "hermes",
  dashboardPort: 18_789,
  gatewayName: "nemoclaw",
  gatewayPort: 8_080,
  lifecycleLiveIdentityFingerprint: FINGERPRINT,
  name: "alpha",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSandbox.mockReturnValue(SANDBOX);
  mocks.getSessionAgent.mockReturnValue({ forwardPort: 18_789, forward_ports: [18_789, 8_642] });
  mocks.getRegisteredAgent.mockReturnValue({
    forwardPort: 18_789,
    forward_ports: [18_789, 8_642],
  });
  mocks.isLocalForwardReachable.mockReturnValue(false);
  mocks.runOpenshell.mockReturnValue({ status: 0 });
  mocks.controller.stop.mockReturnValue("absent");
  mocks.controller.stopPort.mockReturnValue("absent");
  mocks.controller.stopAll.mockReturnValue(0);
  mocks.controller.ensure.mockReturnValue({ action: "started", receipt: {} });
});

describe("ForwardTcp runtime integration", () => {
  it("checks every launch forward from receipt-owned processes without the legacy list", async () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "owned",
      reachable: true,
      receipt: {},
    });
    const capture = vi.fn(() => {
      throw new Error("legacy forward list must not run");
    });
    const { areSandboxLaunchForwardsHealthy } = await import("./forward-recovery");

    expect(areSandboxLaunchForwardsHealthy("alpha", "nemoclaw", capture as never)).toBe(true);
    expect(mocks.controller.inspect).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
  });

  it("uses the receipt-owned process as forward health authority", async () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "owned",
      reachable: true,
      receipt: {},
    });
    const { isSandboxPortForwardHealthy } = await import("./forward-recovery");

    expect(isSandboxPortForwardHealthy("alpha", 18_789)).toBe(true);
    expect(mocks.captureOpenshell).not.toHaveBeenCalled();
    expect(mocks.controller.inspect).toHaveBeenCalledWith(
      {
        gatewayName: "nemoclaw",
        sandboxIdentityFingerprint: FINGERPRINT,
        sandboxName: "alpha",
      },
      { localHost: "127.0.0.1", localPort: 18_789, targetPort: 18_789 },
    );
  });

  it("migrates a healthy legacy SSH forward to ForwardTcp", async () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "absent",
      reachable: false,
      receipt: null,
    });
    mocks.captureOpenshell.mockReturnValue({
      status: 0,
      output: "SANDBOX BIND PORT PID STATUS\nalpha 127.0.0.1 18789 42 running",
    });
    const { ensureSandboxPortForwardForPort } = await import("./forward-recovery");

    expect(ensureSandboxPortForwardForPort("alpha", 18_789)).toBe(true);
    expect(mocks.controller.stop).toHaveBeenCalledOnce();
    expect(mocks.controller.ensure).toHaveBeenCalledOnce();
    expect(mocks.runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789", "alpha"], {
      ignoreError: true,
      stdio: "ignore",
    });
    expect(
      mocks.runOpenshell.mock.calls.some(([args]) => args[0] === "forward" && args[1] === "start"),
    ).toBe(false);
  });

  it("retires every registered ForwardTcp port during sandbox teardown", async () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const { teardownSandboxDashboardForward } = await import("./forward-recovery");

    teardownSandboxDashboardForward("alpha", {
      getSandbox: () => SANDBOX,
      isLocalForwardReachable: () => false,
      runOpenshell,
    });

    expect(mocks.controller.stopAll).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      sandboxIdentityFingerprint: FINGERPRINT,
      sandboxName: "alpha",
    });
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });
});
