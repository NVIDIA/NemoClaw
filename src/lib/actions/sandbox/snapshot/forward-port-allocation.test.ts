// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dashboardPortMocks = vi.hoisted(() => ({
  createOpenShellForwardPortObserver: vi.fn(
    ({ forwardForPort }: { forwardForPort(port: number): object }) =>
      async (ports: readonly number[]) =>
        ports.map((port) => ({ state: "absent" as const, forward: forwardForPort(port) })),
  ),
  findAvailableDashboardPortFromObserver: vi.fn(
    async (
      _sandboxName: string,
      preferredPort: number,
      observeForwardPorts: (ports: readonly number[]) => Promise<readonly object[]>,
    ) => ({ port: 18_901, observations: await observeForwardPorts([preferredPort]) }),
  ),
  getRegistryOccupiedDashboardPorts: vi.fn(() => new Map<string, string>()),
  getRegistryOccupiedHermesApiPorts: vi.fn(() => new Map<string, string>()),
}));

const hermesApiPortMocks = vi.hoisted(() => ({
  findAvailableHermesApiPortFromObserver: vi.fn(
    async (
      _sandboxName: string,
      preferredPort: number,
      observeForwardPorts: (ports: readonly number[]) => Promise<readonly object[]>,
    ) => ({ port: 8_643, observations: await observeForwardPorts([preferredPort]) }),
  ),
}));

const forwardAdapterMocks = vi.hoisted(() => ({
  create: vi.fn(() => ({ observeForwards: vi.fn() })),
}));

vi.mock("../../../onboard/dashboard-port", () => ({
  createOpenShellForwardPortObserver: dashboardPortMocks.createOpenShellForwardPortObserver,
  findAvailableDashboardPortFromObserver: dashboardPortMocks.findAvailableDashboardPortFromObserver,
  getRegistryOccupiedDashboardPorts: dashboardPortMocks.getRegistryOccupiedDashboardPorts,
  getRegistryOccupiedHermesApiPorts: dashboardPortMocks.getRegistryOccupiedHermesApiPorts,
}));

vi.mock("../../../onboard/hermes-api-port", () => ({
  findAvailableHermesApiPortFromObserver: hermesApiPortMocks.findAvailableHermesApiPortFromObserver,
  HERMES_API_PORT_ENV: "NEMOCLAW_HERMES_API_PORT",
  readHermesApiPort: vi.fn(() => 8_642),
}));

vi.mock("../../../adapters/openshell/forward-runtime", () => ({
  createOpenShellForwardAdapterForAuthority: forwardAdapterMocks.create,
  openShellForwardIdentity: (
    authority: object,
    sandboxName: string,
    localHost: string,
    port: number,
  ) => ({ ...authority, sandboxName, localHost, port }),
}));

vi.mock("../../../onboard/gateway-teardown-authority", () => ({
  resolveGatewayForwardAuthority: ({
    gatewayName,
    gatewayPort,
  }: {
    gatewayName: string;
    gatewayPort: number;
  }) => ({
    endpoint: null,
    gatewayName,
    gatewayPort,
    mode: "nemoclaw-managed" as const,
    requiredCapabilities: [],
    source: "standalone" as const,
    stateDir: null,
    supervisor: null,
  }),
}));

vi.mock("../../../onboard/gateway-host-runtime", () => ({
  resolveGatewayForwardRuntimeAuthority: (owner: { gatewayPort: number }) => ({
    gatewayEndpoint: `https://127.0.0.1:${String(owner.gatewayPort)}`,
  }),
}));

import { allocateSnapshotCloneForwardPorts } from "./forward-port-allocation";

beforeEach(() => {
  vi.clearAllMocks();
  dashboardPortMocks.getRegistryOccupiedDashboardPorts.mockReturnValue(new Map());
  dashboardPortMocks.getRegistryOccupiedHermesApiPorts.mockReturnValue(new Map());
});
afterEach(() => vi.unstubAllEnvs());

describe("allocateSnapshotCloneForwardPorts", () => {
  it.each([
    [false, "127.0.0.1"],
    [true, "0.0.0.0"],
  ] as const)(
    "observes clone dashboard ownership with persisted remote bind %s",
    async (dashboardRemoteBindPrepared, expectedBind) => {
      await allocateSnapshotCloneForwardPorts({
        destinationName: "beta",
        executable: "/usr/local/bin/openshell",
        gatewayName: "nemoclaw-18080",
        gatewayPort: 18_080,
        source: {
          agent: "openclaw",
          dashboardPort: 18_790,
          dashboardRemoteBindPrepared,
          hermesDashboardEnabled: false,
          name: "alpha",
        },
      });

      const observerFactoryInput =
        dashboardPortMocks.createOpenShellForwardPortObserver.mock.calls.at(-1)?.[0] as {
          forwardForPort(port: number): { localHost: string };
        };
      expect(observerFactoryInput.forwardForPort(18_790).localHost).toBe(expectedBind);
    },
  );

  it("keeps Hermes API observation loopback and reserves its internal dashboard port", async () => {
    await allocateSnapshotCloneForwardPorts({
      destinationName: "beta",
      executable: "/usr/local/bin/openshell",
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18_080,
      source: {
        agent: "hermes",
        dashboardPort: 18_790,
        dashboardRemoteBindPrepared: true,
        hermesDashboardEnabled: true,
        hermesDashboardInternalPort: 18_901,
        name: "alpha",
      },
    });

    const observers = dashboardPortMocks.createOpenShellForwardPortObserver.mock.calls.map(
      ([input]) => input as { forwardForPort(port: number): { localHost: string } },
    );
    expect(observers.map(({ forwardForPort }) => forwardForPort(18_790).localHost)).toEqual([
      "0.0.0.0",
      "127.0.0.1",
    ]);
    expect(dashboardPortMocks.findAvailableDashboardPortFromObserver).toHaveBeenCalledWith(
      "beta",
      18_790,
      expect.any(Function),
      new Map([["18901", "alpha (Hermes dashboard internal)"]]),
    );
  });
});
