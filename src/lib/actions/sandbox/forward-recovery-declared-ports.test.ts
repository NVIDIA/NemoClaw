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
}));

vi.mock("../../adapters/openshell/runtime", () => ({
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

const HERMES_AGENT = { forward_ports: [18789, 8642], forwardPort: 18789 };

function forwardList(rows: string[]): { status: number; output: string } {
  return {
    status: 0,
    output: ["SANDBOX BIND PORT PID STATUS", ...rows].join("\n"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runOpenshell.mockReturnValue({ status: 0 });
  mocks.isLocalForwardReachable.mockReturnValue(true);
  mocks.getHermesDashboardRecoveryConfig.mockReturnValue(null);
  mocks.getSessionAgent.mockReturnValue(HERMES_AGENT);
});

describe("ensureDeclaredAgentForwardPortsHealthy", () => {
  it("does not demand the manifest dashboard port from a sandbox that owns a different dashboard port (#8543)", async () => {
    mocks.getSandbox.mockReturnValue({
      agent: "hermes",
      dashboardPort: 18790,
      hermesApiPort: 8643,
    });
    mocks.captureOpenshell.mockReturnValue(
      forwardList([
        "alpha 127.0.0.1 18789 101 running",
        "alpha 127.0.0.1 8642 102 running",
        "beta 127.0.0.1 8643 103 running",
      ]),
    );
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18790)).toBe(true);
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });

  it("recovers the sandbox's own API port rather than the sibling sandbox's (#8543)", async () => {
    // The forward never appears in the list, so skip the settle waits and let
    // the call fail fast; this asserts which port recovery targets, not that it
    // converges.
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    mocks.isLocalForwardReachable.mockReturnValue(false);
    mocks.getSandbox.mockReturnValue({
      agent: "hermes",
      dashboardPort: 18790,
      hermesApiPort: 8643,
    });
    mocks.captureOpenshell.mockReturnValue(
      forwardList(["alpha 127.0.0.1 18789 101 running", "alpha 127.0.0.1 8642 102 running"]),
    );
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");
    ensureDeclaredAgentForwardPortsHealthy("beta", 18790);
    const startedPorts = mocks.runOpenshell.mock.calls
      .map(([args]) => args)
      .filter((args) => args[0] === "forward" && args[1] === "start")
      .map((args) => args[3]);
    expect(startedPorts).toContain("8643");
    expect(startedPorts).not.toContain("8642");
  });

  it("keeps the default API port for a sandbox registered without one (#8543)", async () => {
    mocks.getSandbox.mockReturnValue({ agent: "hermes", dashboardPort: 18789 });
    mocks.captureOpenshell.mockReturnValue(
      forwardList(["beta 127.0.0.1 18789 101 running", "beta 127.0.0.1 8642 102 running"]),
    );
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18789)).toBe(true);
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });
});
