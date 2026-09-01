// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDeclaredAgentForwardPortsHealthy } from "./forward-recovery";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  controller: {
    ensure: vi.fn(),
    inspect: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    stopPort: vi.fn(),
  },
  retireLegacy: vi.fn(),
  runOpenshell: vi.fn((_args: string[], _options?: unknown) => ({ status: 0 })),
  getSessionAgent: vi.fn(),
  getSandbox: vi.fn(),
  getHermesDashboardRecoveryConfig: vi.fn(() => null),
  isLocalForwardReachable: vi.fn(() => true),
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
  retireProductionLegacySandboxForwards: mocks.retireLegacy,
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  createForwardServiceController: () => mocks.controller,
  runOpenshell: mocks.runOpenshell,
  isCommandTimeout: () => false,
}));

vi.mock("../../adapters/openshell/forward-service-controller", () => ({
  createForwardServiceController: () => mocks.controller,
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
const authorityFields = {
  gatewayName: "nemoclaw",
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: "a".repeat(64),
  name: "beta",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runOpenshell.mockReturnValue({ status: 0 });
  mocks.isLocalForwardReachable.mockReturnValue(true);
  mocks.getHermesDashboardRecoveryConfig.mockReturnValue(null);
  mocks.getSessionAgent.mockReturnValue(HERMES_AGENT);
  mocks.controller.inspect.mockReturnValue({
    disposition: "owned",
    ownsListener: true,
    reachable: true,
    receipt: {},
  });
  mocks.controller.ensure.mockReturnValue({ action: "started", receipt: {} });
});

describe("ensureDeclaredAgentForwardPortsHealthy", () => {
  it("does not demand the manifest dashboard port from a sandbox that owns a different dashboard port (#8543)", () => {
    mocks.getSandbox.mockReturnValue({
      agent: "hermes",
      ...authorityFields,
      dashboardPort: 18790,
      hermesApiPort: 8643,
    });
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18790)).toBe(true);
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });

  it("recovers the sandbox's own API port rather than the sibling sandbox's (#8543)", () => {
    mocks.controller.inspect.mockReturnValue({
      disposition: "absent",
      ownsListener: false,
      reachable: false,
      receipt: null,
    });
    mocks.getSandbox.mockReturnValue({
      agent: "hermes",
      ...authorityFields,
      dashboardPort: 18790,
      hermesApiPort: 8643,
    });
    ensureDeclaredAgentForwardPortsHealthy("beta", 18790);
    expect(mocks.controller.ensure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ localPort: 8643, targetPort: 8643 }),
    );
    expect(mocks.controller.ensure).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ localPort: 8642 }),
    );
  });

  it("keeps the default API port for a sandbox registered without one (#8543)", () => {
    mocks.getSandbox.mockReturnValue({ agent: "hermes", ...authorityFields, dashboardPort: 18789 });
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18789)).toBe(true);
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });
});
