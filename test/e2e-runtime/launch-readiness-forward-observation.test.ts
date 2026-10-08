// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import { areSandboxLaunchForwardsHealthy } from "../../src/lib/actions/sandbox/forward-recovery.ts";
import type {
  ObserveOpenShellForwardsRequest,
  OpenShellForwardIdentity,
  OpenShellForwardObservation,
} from "../../src/lib/adapters/openshell/forward.ts";
import type { OpenShellForwardRuntimeAuthority } from "../../src/lib/adapters/openshell/forward-runtime.ts";
import * as agentRuntime from "../../src/lib/agent/runtime.ts";
import * as gatewayTeardownAuthority from "../../src/lib/onboard/gateway-teardown-authority.ts";
import * as platform from "../../src/lib/platform.ts";
import * as registry from "../../src/lib/state/registry.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type ObservableState = OpenShellForwardObservation["state"];

function gatewayAuthority(endpoint: string | null) {
  return {
    gatewayName: "nemoclaw",
    gatewayPort: 8_080,
    mode: "nemoclaw-managed",
    source: "standalone",
    endpoint,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  } as const;
}

function observation(
  forward: OpenShellForwardIdentity,
  state: ObservableState,
): OpenShellForwardObservation {
  return state === "indeterminate"
    ? {
        state,
        forward,
        error: {
          kind: "transport",
          message: "The OpenShell forward transport failed.",
        },
      }
    : { state, forward };
}

function createFakeAdapter(
  stateForPort: (port: number) => ObservableState = () => "owned",
  afterObservation?: () => void,
) {
  const startForward = vi.fn();
  const observeForwards = vi.fn(async (request: ObserveOpenShellForwardsRequest) => {
    await request.assertCurrent?.();
    const observations = request.forwards.map((forward) =>
      observation(forward, stateForPort(forward.port)),
    );
    afterObservation?.();
    await request.assertCurrent?.();
    return observations;
  });
  const forwardAdapterForAuthority = vi.fn((_authority: OpenShellForwardRuntimeAuthority) => ({
    observeForwards,
    startForward,
  }));
  return { forwardAdapterForAuthority, observeForwards, startForward };
}

function mockLaunchForwardAuthority(gatewayRuntime = true): void {
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    name: "openclaw",
    runtime: { kind: gatewayRuntime ? "gateway" : "terminal" },
    forward_ports: [18_790],
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "beta",
    agent: "openclaw",
    dashboardPort: 18_789,
    gatewayName: "nemoclaw",
    gatewayPort: 8_080,
  });
  vi.spyOn(registry, "getSandboxAcrossGatewayRoots").mockImplementation((sandboxName) =>
    registry.getSandbox(sandboxName),
  );
  vi.spyOn(platform, "isWsl").mockReturnValue(false);
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayForwardAuthority").mockReturnValue(
    gatewayAuthority(null),
  );
}

it("requires one exact owned observation for every registered launch-forward port", async () => {
  mockLaunchForwardAuthority();
  const fake = createFakeAdapter();

  await expect(areSandboxLaunchForwardsHealthy("beta", undefined, fake)).resolves.toBe(true);
  expect(fake.observeForwards).toHaveBeenCalledOnce();
  expect(fake.observeForwards.mock.calls[0]?.[0].forwards).toEqual([
    {
      gatewayEndpoint: "https://127.0.0.1:8080",
      gatewayName: "nemoclaw",
      workspace: "default",
      sandboxName: "beta",
      localHost: "127.0.0.1",
      port: 18_789,
    },
    {
      gatewayEndpoint: "https://127.0.0.1:8080",
      gatewayName: "nemoclaw",
      workspace: "default",
      sandboxName: "beta",
      localHost: "127.0.0.1",
      port: 18_790,
    },
  ]);
});

it("checks sandbox-owned Hermes ports instead of manifest defaults", async () => {
  mockLaunchForwardAuthority();
  vi.mocked(agentRuntime.getSessionAgent).mockReturnValue({
    name: "hermes",
    runtime: { kind: "gateway" },
    forwardPort: 18_789,
    forward_ports: [18_789, 8_642],
  } as never);
  vi.mocked(registry.getSandbox).mockReturnValue({
    name: "beta",
    agent: "hermes",
    dashboardPort: 18_790,
    hermesApiPort: 8_643,
    gatewayName: "nemoclaw",
    gatewayPort: 8_080,
  });
  const fake = createFakeAdapter();

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(true);
  expect(fake.observeForwards.mock.calls[0]?.[0].forwards.map(({ port }) => port)).toEqual([
    18_790, 8_643,
  ]);
});

it.each([
  ["a remote dashboard", () => vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0")],
  ["WSL", () => vi.mocked(platform.isWsl).mockReturnValue(true)],
])(
  "proves %s uses an all-interface primary forward and loopback auxiliaries",
  async (_case, arrange) => {
    mockLaunchForwardAuthority();
    arrange();
    const fake = createFakeAdapter();

    await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(true);
    expect(
      fake.observeForwards.mock.calls[0]?.[0].forwards.map(({ localHost, port }) => ({
        localHost,
        port,
      })),
    ).toEqual([
      { localHost: "0.0.0.0", port: 18_789 },
      { localHost: "127.0.0.1", port: 18_790 },
    ]);
  },
);

it.each(["foreign", "absent", "stale"] as const)(
  "rejects a %s primary listener without attempting a launch",
  async (state) => {
    mockLaunchForwardAuthority();
    const fake = createFakeAdapter((port) => (port === 18_789 ? state : "owned"));

    await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(false);
    expect(fake.startForward).not.toHaveBeenCalled();
  },
);

it("returns null for an indeterminate observation without attempting a launch", async () => {
  mockLaunchForwardAuthority();
  const fake = createFakeAdapter(() => "indeterminate");

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(null);
  expect(fake.startForward).not.toHaveBeenCalled();
});

it("rejects gateway authority drift across the atomic observation", async () => {
  mockLaunchForwardAuthority();
  let endpoint = "http://127.0.0.1:8080";
  vi.mocked(gatewayTeardownAuthority.resolveGatewayForwardAuthority).mockImplementation(() =>
    gatewayAuthority(endpoint),
  );
  const fake = createFakeAdapter(
    () => "owned",
    () => {
      endpoint = "https://127.0.0.1:8080";
    },
  );

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(null);
});

it("rejects registry gateway drift during the atomic observation", async () => {
  mockLaunchForwardAuthority();
  const currentSandbox = vi.mocked(registry.getSandbox).getMockImplementation()!;
  const fake = createFakeAdapter(
    () => "owned",
    () => {
      vi.mocked(registry.getSandbox).mockReturnValue({
        ...currentSandbox("beta")!,
        gatewayName: "nemoclaw-19080",
        gatewayPort: 19_080,
      });
    },
  );

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(null);
});

it("rejects primary-bind drift after every exact target was proved", async () => {
  mockLaunchForwardAuthority();
  const fake = createFakeAdapter(
    () => "owned",
    () => {
      vi.mocked(platform.isWsl).mockReturnValue(true);
    },
  );

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(null);
});

it("rejects same-gateway primary-port drift after every exact target was proved", async () => {
  mockLaunchForwardAuthority();
  const currentSandbox = vi.mocked(registry.getSandbox).getMockImplementation()!;
  const fake = createFakeAdapter(
    () => "owned",
    () => {
      vi.mocked(registry.getSandbox).mockReturnValue({
        ...currentSandbox("beta")!,
        dashboardPort: 18_791,
      });
    },
  );

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(null);
});

it("rejects same-gateway required-port drift after every exact target was proved", async () => {
  mockLaunchForwardAuthority();
  const fake = createFakeAdapter(
    () => "owned",
    () => {
      vi.mocked(agentRuntime.getSessionAgent).mockReturnValue({
        name: "openclaw",
        runtime: { kind: "gateway" },
        forward_ports: [18_791],
      } as never);
    },
  );

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(null);
});

it("returns null when adapter observation cannot complete", async () => {
  mockLaunchForwardAuthority();
  const observeForwards = vi.fn(async () => {
    throw new Error("observer unavailable");
  });

  await expect(
    areSandboxLaunchForwardsHealthy("beta", "nemoclaw", {
      forwardAdapterForAuthority: () => ({ observeForwards }),
    }),
  ).resolves.toBe(null);
});

it("accepts a stable terminal agent without creating an adapter", async () => {
  mockLaunchForwardAuthority(false);
  const fake = createFakeAdapter();

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(true);
  expect(fake.forwardAdapterForAuthority).not.toHaveBeenCalled();
  expect(gatewayTeardownAuthority.resolveGatewayForwardAuthority).not.toHaveBeenCalled();
  expect(platform.isWsl).not.toHaveBeenCalled();
});

it("rejects terminal-to-gateway plan drift before reporting zero forwards healthy", async () => {
  mockLaunchForwardAuthority(false);
  vi.mocked(agentRuntime.getSessionAgent)
    .mockReturnValueOnce({
      name: "openclaw",
      runtime: { kind: "terminal" },
      forward_ports: [18_790],
    } as never)
    .mockReturnValue({
      name: "openclaw",
      runtime: { kind: "gateway" },
      forward_ports: [18_790],
    } as never);
  const fake = createFakeAdapter();

  await expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw", fake)).resolves.toBe(null);
  expect(fake.forwardAdapterForAuthority).not.toHaveBeenCalled();
});

it("rejects an owning-gateway mismatch before creating an adapter", async () => {
  mockLaunchForwardAuthority(false);
  const fake = createFakeAdapter();

  await expect(areSandboxLaunchForwardsHealthy("beta", "ambient-sibling", fake)).resolves.toBe(
    false,
  );
  expect(fake.forwardAdapterForAuthority).not.toHaveBeenCalled();
});
