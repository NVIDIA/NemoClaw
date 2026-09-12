// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import * as forwardHealth from "../../src/lib/actions/sandbox/forward-health.ts";
import { areSandboxLaunchForwardsHealthy } from "../../src/lib/actions/sandbox/forward-recovery.ts";
import * as forwardService from "../../src/lib/adapters/openshell/forward-service.ts";
import * as openshellResolve from "../../src/lib/adapters/openshell/resolve.ts";
import * as agentRuntime from "../../src/lib/agent/runtime.ts";
import * as gatewayTeardownAuthority from "../../src/lib/onboard/gateway-teardown-authority.ts";
import * as platform from "../../src/lib/platform.ts";
import * as registry from "../../src/lib/state/registry.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

function mockLaunchForwardObservation(reachable = true, gatewayRuntime = true, owned = true): void {
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
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
  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(reachable);
  vi.spyOn(forwardService, "isForwardServiceListenerOwner").mockReturnValue(owned);
  vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue("/usr/local/bin/openshell");
  vi.spyOn(platform, "isWsl").mockReturnValue(false);
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayForwardAuthority").mockReturnValue(
    gatewayAuthority(null),
  );
}

it("requires exact ownership for every registered launch-forward port", () => {
  mockLaunchForwardObservation();

  expect(areSandboxLaunchForwardsHealthy("beta")).toBe(true);
  expect(vi.mocked(forwardHealth.isLocalForwardReachable).mock.calls).toEqual([[18_789], [18_790]]);
  expect(vi.mocked(forwardService.isForwardServiceListenerOwner).mock.calls).toEqual([
    [
      {
        executable: "/usr/local/bin/openshell",
        gatewayEndpoint: "https://127.0.0.1:8080",
        gatewayName: "nemoclaw",
        workspace: "default",
        sandboxName: "beta",
        localHost: "127.0.0.1",
        localPort: 18_789,
        targetHost: "127.0.0.1",
        targetPort: 18_789,
      },
    ],
    [
      {
        executable: "/usr/local/bin/openshell",
        gatewayEndpoint: "https://127.0.0.1:8080",
        gatewayName: "nemoclaw",
        workspace: "default",
        sandboxName: "beta",
        localHost: "127.0.0.1",
        localPort: 18_790,
        targetHost: "127.0.0.1",
        targetPort: 18_790,
      },
    ],
  ]);
});

it("checks sandbox-owned Hermes ports instead of manifest defaults", () => {
  mockLaunchForwardObservation();
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

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(true);
  expect(vi.mocked(forwardHealth.isLocalForwardReachable).mock.calls).toEqual([[18_790], [8_643]]);
});

it.each([
  ["a remote dashboard", () => vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0")],
  ["WSL", () => vi.mocked(platform.isWsl).mockReturnValue(true)],
])("proves %s uses an all-interface primary forward and loopback auxiliaries", (_case, arrange) => {
  mockLaunchForwardObservation();
  arrange();

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(true);
  expect(
    vi.mocked(forwardService.isForwardServiceListenerOwner).mock.calls.map(([target]) => ({
      localHost: target.localHost,
      localPort: target.localPort,
    })),
  ).toEqual([
    { localHost: "0.0.0.0", localPort: 18_789 },
    { localHost: "127.0.0.1", localPort: 18_790 },
  ]);
});

it("rejects a reachable foreign primary listener", () => {
  mockLaunchForwardObservation(true, true, false);

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(false);
  expect(forwardHealth.isLocalForwardReachable).toHaveBeenCalledWith(18_789);
  expect(forwardService.isForwardServiceListenerOwner).toHaveBeenCalledOnce();
});

it("rejects a reachable foreign auxiliary listener", () => {
  mockLaunchForwardObservation();
  vi.mocked(forwardService.isForwardServiceListenerOwner).mockImplementation(
    (target) => target.localPort === 18_789,
  );

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(false);
  expect(vi.mocked(forwardService.isForwardServiceListenerOwner)).toHaveBeenCalledTimes(2);
});

it("rejects gateway authority drift across exact multi-port proofs", () => {
  mockLaunchForwardObservation();
  let endpoint = "http://127.0.0.1:8080";
  vi.mocked(gatewayTeardownAuthority.resolveGatewayForwardAuthority).mockImplementation(() =>
    gatewayAuthority(endpoint),
  );
  vi.mocked(forwardHealth.isLocalForwardReachable)
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      endpoint = "https://127.0.0.1:8080";
      return true;
    });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
  expect(vi.mocked(forwardService.isForwardServiceListenerOwner).mock.calls).toEqual([
    [
      {
        executable: "/usr/local/bin/openshell",
        gatewayEndpoint: "http://127.0.0.1:8080",
        gatewayName: "nemoclaw",
        workspace: "default",
        sandboxName: "beta",
        localHost: "127.0.0.1",
        localPort: 18_789,
        targetHost: "127.0.0.1",
        targetPort: 18_789,
      },
    ],
    [
      {
        executable: "/usr/local/bin/openshell",
        gatewayEndpoint: "http://127.0.0.1:8080",
        gatewayName: "nemoclaw",
        workspace: "default",
        sandboxName: "beta",
        localHost: "127.0.0.1",
        localPort: 18_790,
        targetHost: "127.0.0.1",
        targetPort: 18_790,
      },
    ],
  ]);
});

it("rejects registry gateway drift after the requested gateway initially matches", () => {
  mockLaunchForwardObservation();
  vi.mocked(registry.getSandbox)
    .mockReturnValueOnce({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18_789,
      gatewayName: "nemoclaw",
      gatewayPort: 8_080,
    })
    .mockReturnValue({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18_789,
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19_080,
    });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
  expect(forwardHealth.isLocalForwardReachable).not.toHaveBeenCalled();
  expect(forwardService.isForwardServiceListenerOwner).not.toHaveBeenCalled();
});

it("rejects OpenShell executable drift after every exact target was proved", () => {
  mockLaunchForwardObservation();
  vi.mocked(openshellResolve.resolveOpenshell)
    .mockReturnValueOnce("/usr/local/bin/openshell-a")
    .mockReturnValue("/usr/local/bin/openshell-b");

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
  expect(
    vi
      .mocked(forwardService.isForwardServiceListenerOwner)
      .mock.calls.map(([target]) => target.executable),
  ).toEqual(["/usr/local/bin/openshell-a", "/usr/local/bin/openshell-a"]);
});

it("rejects primary-bind drift after every exact target was proved", () => {
  mockLaunchForwardObservation();
  vi.mocked(platform.isWsl).mockReturnValueOnce(false).mockReturnValue(true);

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
  expect(
    vi
      .mocked(forwardService.isForwardServiceListenerOwner)
      .mock.calls.map(([target]) => target.localHost),
  ).toEqual(["127.0.0.1", "127.0.0.1"]);
});

it("rejects same-gateway primary-port drift after every exact target was proved", () => {
  mockLaunchForwardObservation();
  let currentSandbox = {
    name: "beta",
    agent: "openclaw",
    dashboardPort: 18_789,
    gatewayName: "nemoclaw",
    gatewayPort: 8_080,
  };
  vi.mocked(registry.getSandbox).mockImplementation(() => currentSandbox);
  vi.mocked(forwardService.isForwardServiceListenerOwner)
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      currentSandbox = { ...currentSandbox, dashboardPort: 18_791 };
      return true;
    });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
  expect(
    vi
      .mocked(forwardService.isForwardServiceListenerOwner)
      .mock.calls.map(([target]) => target.localPort),
  ).toEqual([18_789, 18_790]);
});

it("rejects same-gateway required-port drift after every exact target was proved", () => {
  mockLaunchForwardObservation();
  let currentAgent = {
    runtime: { kind: "gateway" },
    forward_ports: [18_790],
  };
  vi.mocked(agentRuntime.getSessionAgent).mockImplementation(() => currentAgent as never);
  vi.mocked(forwardService.isForwardServiceListenerOwner)
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      currentAgent = { ...currentAgent, forward_ports: [18_791] };
      return true;
    });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
  expect(
    vi
      .mocked(forwardService.isForwardServiceListenerOwner)
      .mock.calls.map(([target]) => target.localPort),
  ).toEqual([18_789, 18_790]);
});

it("returns false when any registered launch-forward port is unreachable", () => {
  mockLaunchForwardObservation(false);
  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(false);
});

it("returns null when forward observation cannot complete", () => {
  mockLaunchForwardObservation();
  vi.mocked(forwardHealth.isLocalForwardReachable).mockImplementation(() => {
    throw new Error("listener probe unavailable");
  });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
});

it("returns null when exact ownership observation cannot complete", () => {
  mockLaunchForwardObservation();
  vi.mocked(forwardService.isForwardServiceListenerOwner).mockImplementation(() => {
    throw new Error("ownership probe unavailable");
  });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
});

it("accepts a stable terminal agent without probing a forward or gateway authority", () => {
  mockLaunchForwardObservation(true, false);

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(true);
  expect(forwardHealth.isLocalForwardReachable).not.toHaveBeenCalled();
  expect(forwardService.isForwardServiceListenerOwner).not.toHaveBeenCalled();
  expect(openshellResolve.resolveOpenshell).not.toHaveBeenCalled();
  expect(gatewayTeardownAuthority.resolveGatewayForwardAuthority).not.toHaveBeenCalled();
  expect(platform.isWsl).not.toHaveBeenCalled();
});

it("rejects terminal-to-gateway plan drift before reporting zero forwards healthy", () => {
  mockLaunchForwardObservation(true, false);
  vi.mocked(agentRuntime.getSessionAgent)
    .mockReturnValueOnce({
      runtime: { kind: "terminal" },
      forward_ports: [18_790],
    } as never)
    .mockReturnValue({
      runtime: { kind: "gateway" },
      forward_ports: [18_790],
    } as never);

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(null);
  expect(forwardHealth.isLocalForwardReachable).not.toHaveBeenCalled();
  expect(forwardService.isForwardServiceListenerOwner).not.toHaveBeenCalled();
  expect(openshellResolve.resolveOpenshell).not.toHaveBeenCalled();
  expect(gatewayTeardownAuthority.resolveGatewayForwardAuthority).not.toHaveBeenCalled();
});

it("rejects an owning-gateway mismatch before probing ports", () => {
  mockLaunchForwardObservation(true, false);

  expect(areSandboxLaunchForwardsHealthy("beta", "ambient-sibling")).toBe(false);
  expect(forwardHealth.isLocalForwardReachable).not.toHaveBeenCalled();
});
