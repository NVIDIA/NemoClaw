// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn((_args: string[], _options?: unknown) => ({ status: 0 })),
  getSessionAgent: vi.fn(),
  getSandbox: vi.fn(),
  getHermesDashboardRecoveryConfig: vi.fn(() => null),
  isLocalForwardReachable: vi.fn(() => true),
  isForwardServiceListenerOwner: vi.fn(() => true),
  launchForwardService: vi.fn(),
}));

vi.mock("../../adapters/openshell/forward-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/forward-service")>()),
  isForwardServiceListenerOwner: mocks.isForwardServiceListenerOwner,
  launchForwardService: mocks.launchForwardService,
}));

vi.mock("../../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/resolve")>()),
  resolveOpenshell: () => "/usr/local/bin/openshell",
}));

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  captureOpenshell: mocks.captureOpenshell,
  runOpenshell: mocks.runOpenshell,
  isCommandTimeout: () => false,
}));

vi.mock("../../agent/runtime", () => ({
  getSessionAgent: mocks.getSessionAgent,
  hasGatewayRuntime: () => true,
}));

vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
}));

vi.mock("./hermes-dashboard-recovery", () => ({
  getHermesDashboardRecoveryConfig: mocks.getHermesDashboardRecoveryConfig,
  ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
}));

vi.mock("./forward-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./forward-health")>()),
  isLocalForwardReachable: mocks.isLocalForwardReachable,
}));

function forwardList(rows: string[]): { status: number; output: string } {
  return { status: 0, output: ["SANDBOX BIND PORT PID STATUS", ...rows].join("\n") };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.runOpenshell.mockReturnValue({ status: 0 });
  mocks.isLocalForwardReachable.mockReturnValue(true);
  mocks.isForwardServiceListenerOwner.mockReturnValue(true);
  mocks.getHermesDashboardRecoveryConfig.mockReturnValue(null);
  mocks.getSessionAgent.mockReturnValue(null);
  mocks.getSandbox.mockReturnValue({ agent: "openclaw", dashboardPort: 18789 });
  mocks.captureOpenshell.mockReturnValue(forwardList([]));
});

describe("a dashboard port held by a listener the sandbox does not own (#11149)", () => {
  it.each([
    ["nothing listens", () => mocks.isLocalForwardReachable.mockReturnValue(false), "absent"],
    [
      "a tracked legacy forward listens",
      () =>
        mocks.captureOpenshell.mockReturnValue(
          forwardList(["box  127.0.0.1  18789  4242  running"]),
        ),
      "legacy",
    ],
    ["the sandbox's own ForwardTcp service listens", () => undefined, "owned"],
    [
      "an unrelated process listens",
      () => mocks.isForwardServiceListenerOwner.mockReturnValue(false),
      "unverified",
    ],
  ])("describes the listener when %s", async (_case, arrange, expected) => {
    arrange();
    const { describeSandboxForwardListener } = await import("./forward-recovery");

    expect(describeSandboxForwardListener("box", { isWsl: false })).toBe(expected);
  });

  it("refuses to relaunch onto it, names the port and leaves it running", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.isForwardServiceListenerOwner.mockReturnValue(false);
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);

    expect(mocks.launchForwardService).not.toHaveBeenCalled();
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
    const message = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(message).toContain(
      "Host port 18789 for 'box' is held by a listener that NemoClaw cannot attribute to this sandbox's OpenShell forward",
    );
    expect(message).toContain("nemoclaw box recover");
  });

  it("still relaunches when nothing listens", async () => {
    mocks.isLocalForwardReachable.mockReturnValue(false);
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(true);

    expect(mocks.launchForwardService).toHaveBeenCalledOnce();
  });
});
