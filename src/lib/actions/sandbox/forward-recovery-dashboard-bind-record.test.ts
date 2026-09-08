// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn((_args: string[], _options?: unknown) => ({ status: 0 })),
  getSandbox: vi.fn(),
  updateSandbox: vi.fn(() => true),
  isLocalForwardReachable: vi.fn(() => false),
  launchForwardService: vi.fn(),
}));

vi.mock("../../adapters/openshell/forward-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/forward-service")>()),
  launchForwardService: mocks.launchForwardService,
}));
vi.mock("../../adapters/openshell/resolve", () => ({
  resolveOpenshell: () => "/usr/local/bin/openshell",
}));
vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  runOpenshell: mocks.runOpenshell,
  isCommandTimeout: () => false,
}));
vi.mock("../../agent/runtime", () => ({
  getSessionAgent: () => ({ forward_ports: [18789], forwardPort: 18789 }),
  hasGatewayRuntime: () => true,
}));
vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
  updateSandbox: mocks.updateSandbox,
}));
vi.mock("./hermes-dashboard-recovery", () => ({
  getHermesDashboardRecoveryConfig: () => null,
  ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
}));
vi.mock("./forward-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./forward-health")>()),
  isLocalForwardReachable: mocks.isLocalForwardReachable,
}));

import { ensureSandboxPortForward, ensureSandboxPortForwardForPort } from "./forward-recovery";

const SANDBOX = { name: "hm", agent: "hermes", dashboardPort: 18789 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.runOpenshell.mockReturnValue({ status: 0 });
  // An empty forward list for the legacy-migration probe that runs before a
  // launch; `clearAllMocks` keeps return values, so set it for every test.
  mocks.captureOpenshell.mockReturnValue({ status: 0, output: "SANDBOX BIND PORT PID STATUS" });
  mocks.updateSandbox.mockReturnValue(true);
  mocks.getSandbox.mockReturnValue(SANDBOX);
  // Not reachable until the launch runs, so every test below exercises the
  // path that actually creates a forward.
  mocks.isLocalForwardReachable.mockReturnValue(false);
  mocks.launchForwardService.mockImplementation(() => {
    mocks.isLocalForwardReachable.mockReturnValue(true);
  });
});

describe("the recorded dashboard bind follows the forward (#10861)", () => {
  it("records the loopback bind when recovery re-creates the forward without an opt-in", () => {
    expect(ensureSandboxPortForward("hm", { isWsl: false })).toBe(true);

    expect(mocks.launchForwardService).toHaveBeenCalledOnce();
    expect(mocks.updateSandbox).toHaveBeenCalledWith("hm", { dashboardBindAddress: "127.0.0.1" });
  });

  it("records the wide bind when the operator opted in and the sandbox was prepared for it", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    mocks.getSandbox.mockReturnValue({ ...SANDBOX, dashboardRemoteBindPrepared: true });

    expect(ensureSandboxPortForward("hm", { isWsl: false })).toBe(true);

    expect(mocks.updateSandbox).toHaveBeenCalledWith("hm", { dashboardBindAddress: "0.0.0.0" });
  });

  it("leaves the record alone when the forward is already reachable", () => {
    mocks.isLocalForwardReachable.mockReturnValue(true);

    expect(ensureSandboxPortForward("hm", { isWsl: false })).toBe(true);

    expect(mocks.launchForwardService).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not record a bind for a forward that is not the dashboard's", () => {
    expect(ensureSandboxPortForwardForPort("hm", 8642, { expectedBind: "127.0.0.1" })).toBe(true);

    expect(mocks.launchForwardService).toHaveBeenCalledOnce();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("keeps the forward up and warns when the record cannot be written", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.updateSandbox.mockReturnValue(false);

    expect(ensureSandboxPortForward("hm", { isWsl: false })).toBe(true);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("could not be recorded"));
  });
});
