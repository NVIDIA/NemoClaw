// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import * as forwardHealth from "../../src/lib/actions/sandbox/forward-health.ts";
import { areSandboxLaunchForwardsHealthy } from "../../src/lib/actions/sandbox/forward-recovery.ts";
import * as agentRuntime from "../../src/lib/agent/runtime.ts";
import * as registry from "../../src/lib/state/registry.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockLaunchForwardObservation(reachable = true, gatewayRuntime = true): void {
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
}

it("checks each registered launch-forward port without inspecting a process", () => {
  mockLaunchForwardObservation();

  expect(areSandboxLaunchForwardsHealthy("beta")).toBe(true);
  expect(vi.mocked(forwardHealth.isLocalForwardReachable).mock.calls).toEqual([[18_789], [18_790]]);
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

it("returns false when any registered launch-forward port is unreachable", () => {
  mockLaunchForwardObservation(false);
  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(false);
});

it("rejects an owning-gateway mismatch before probing ports", () => {
  mockLaunchForwardObservation(true, false);

  expect(areSandboxLaunchForwardsHealthy("beta", "ambient-sibling")).toBe(false);
  expect(forwardHealth.isLocalForwardReachable).not.toHaveBeenCalled();
});
