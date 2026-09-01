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
  retireLegacy: vi.fn(),
  runOpenshell: vi.fn(),
}));

vi.mock("../../onboard/forward-service-migration", () => ({
  requireProductionForwardServiceAuthority: () => ({
    authority: {
      gatewayName: "nemoclaw",
      sandboxIdentityFingerprint: "a".repeat(64),
      sandboxName: "alpha",
    },
    migrated: false,
    assertCurrent: vi.fn(),
    assertLiveCurrent: vi.fn(),
  }),
  retireProductionLegacySandboxForwards: mocks.retireLegacy,
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
  mocks.controller.ensure.mockImplementation((_authority, _endpoint, options) => {
    options?.retireLegacy?.();
    return { action: "started", receipt: {} };
  });
});

describe("ForwardTcp runtime integration", () => {
  it("checks every launch forward from receipt-owned processes without the legacy list", async () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "owned",
      ownsListener: true,
      reachable: true,
      receipt: {},
    });
    const capture = vi.fn(() => {
      throw new Error("legacy forward list must not run");
    });
    const { areSandboxLaunchForwardsHealthy } = await import("./forward-recovery");

    expect(areSandboxLaunchForwardsHealthy("alpha", "nemoclaw", capture as never)).toBe(true);
    expect(mocks.controller.inspect.mock.calls.map(([, inspected]) => inspected)).toEqual([
      { localHost: "127.0.0.1", localPort: 18_789, targetPort: 18_789 },
      { localHost: "127.0.0.1", localPort: 8_642, targetPort: 8_642 },
    ]);
    expect(capture).not.toHaveBeenCalled();
  });

  it("uses the receipt-owned process as forward health authority", async () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "owned",
      ownsListener: true,
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

  it("rejects a reachable port that the receipt-owned process does not listen on", async () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "owned",
      ownsListener: false,
      reachable: true,
      receipt: {},
    });
    const { isSandboxPortForwardHealthy } = await import("./forward-recovery");

    expect(isSandboxPortForwardHealthy("alpha", 18_789)).toBe(false);
    expect(mocks.captureOpenshell).not.toHaveBeenCalled();
  });

  it("migrates legacy SSH forwards before starting ForwardTcp", async () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "absent",
      ownsListener: false,
      reachable: false,
      receipt: null,
    });
    const { ensureSandboxPortForwardForPort } = await import("./forward-recovery");

    expect(ensureSandboxPortForwardForPort("alpha", 18_789)).toBe(true);
    expect(mocks.controller.stop).not.toHaveBeenCalled();
    expect(mocks.controller.ensure).toHaveBeenCalledOnce();
    expect(mocks.retireLegacy).toHaveBeenCalledOnce();
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });

  it("retires every registered ForwardTcp port during sandbox teardown", async () => {
    mocks.controller.stopAll.mockReturnValue(2);
    const { teardownSandboxDashboardForward } = await import("./forward-recovery");

    expect(
      teardownSandboxDashboardForward("alpha", {
        getSandbox: () => SANDBOX,
        isLocalForwardReachable: () => false,
      }),
    ).toBe(true);

    expect(mocks.controller.stopAll).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      sandboxIdentityFingerprint: FINGERPRINT,
      sandboxName: "alpha",
    });
    expect(mocks.retireLegacy).toHaveBeenCalledOnce();
  });

  it("restores the complete declared ForwardTcp set after an intact delete rollback", async () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "absent",
      ownsListener: false,
      reachable: false,
      receipt: null,
    });
    const { restoreSandboxLaunchForwards } = await import("./forward-recovery");

    expect(restoreSandboxLaunchForwards("alpha")).toBe(true);
    expect(mocks.controller.ensure.mock.calls.map(([, restored]) => restored)).toEqual([
      { localHost: "127.0.0.1", localPort: 18_789, targetPort: 18_789 },
      { localHost: "127.0.0.1", localPort: 8_642, targetPort: 8_642 },
    ]);
  });

  it("reports a mixed legacy listener without using mutable-name cleanup", async () => {
    mocks.controller.stopAll.mockReturnValue(2);
    const { teardownSandboxDashboardForward } = await import("./forward-recovery");

    expect(
      teardownSandboxDashboardForward("alpha", {
        getSandbox: () => SANDBOX,
        isLocalForwardReachable: () => true,
      }),
    ).toBe(false);
  });

  it("runs the legacy migration seam before receipt cleanup", async () => {
    const { teardownSandboxDashboardForward } = await import("./forward-recovery");

    expect(
      teardownSandboxDashboardForward("alpha", {
        getSandbox: () => SANDBOX,
        isLocalForwardReachable: () => false,
      }),
    ).toBe(true);
    expect(mocks.retireLegacy).toHaveBeenCalledOnce();
    expect(mocks.controller.stopAll).toHaveBeenCalledOnce();
  });

  it("reports incomplete teardown when exact ForwardTcp authority is ambiguous", async () => {
    mocks.controller.stopAll.mockImplementation(() => {
      throw new Error("receipt changed");
    });
    const { teardownSandboxDashboardForward } = await import("./forward-recovery");

    expect(
      teardownSandboxDashboardForward("alpha", {
        getSandbox: () => SANDBOX,
        isLocalForwardReachable: () => false,
      }),
    ).toBe(false);
  });
});
