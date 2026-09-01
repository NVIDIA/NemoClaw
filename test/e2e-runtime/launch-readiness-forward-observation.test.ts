// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { areSandboxLaunchForwardsHealthy } from "../../src/lib/actions/sandbox/forward-recovery.ts";
import * as agentRuntime from "../../src/lib/agent/runtime.ts";
import * as registry from "../../src/lib/state/registry.ts";
import { forwardServiceControllerTestDouble as forwardMocks } from "../support/forward-service-controller-test-double";

vi.mock("../../src/lib/adapters/openshell/forward-service-controller", async () => {
  const { forwardServiceControllerTestDouble } =
    await import("../support/forward-service-controller-test-double");
  return { createForwardServiceController: () => forwardServiceControllerTestDouble.controller };
});

beforeEach(() => {
  forwardMocks.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockLaunchForwardObservation(gatewayRuntime = true) {
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    runtime: { kind: gatewayRuntime ? "gateway" : "terminal" },
    forward_ports: [18790],
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "beta",
    agent: "openclaw",
    dashboardPort: 18789,
    forwardServiceMigrationVersion: 1,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "current-generation",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
  });
}

it("checks launch forwards through the sandbox's owning gateway without repair (#8942)", () => {
  mockLaunchForwardObservation();
  forwardMocks.seed("beta", "127.0.0.1", 18789);
  forwardMocks.seed("beta", "127.0.0.1", 18790);

  expect(areSandboxLaunchForwardsHealthy("beta")).toBe(true);
  expect(forwardMocks.controller.inspect).toHaveBeenCalledTimes(2);
});

it("checks sandbox-owned Hermes forwards instead of manifest defaults (#9716)", () => {
  mockLaunchForwardObservation();
  vi.mocked(agentRuntime.getSessionAgent).mockReturnValue({
    name: "hermes",
    runtime: { kind: "gateway" },
    forwardPort: 18789,
    forward_ports: [18789, 8642],
  } as never);
  vi.mocked(registry.getSandbox).mockReturnValue({
    name: "beta",
    agent: "hermes",
    dashboardPort: 18790,
    forwardServiceMigrationVersion: 1,
    hermesApiPort: 8643,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "current-generation",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
  });
  forwardMocks.seed("beta", "127.0.0.1", 18790);
  forwardMocks.seed("beta", "127.0.0.1", 8643);

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(true);
  expect(
    forwardMocks.controller.inspect.mock.calls.map(([, endpoint]) => endpoint.localPort),
  ).toEqual([18790, 8643]);
});

it("rejects a reachable listener when the owning forward row is missing (#8942)", () => {
  mockLaunchForwardObservation();

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(false);
});

it("returns unknown when the owner-scoped forward observation fails (#8942)", () => {
  mockLaunchForwardObservation();
  forwardMocks.controller.inspect.mockImplementation(() => {
    throw new Error("OpenShell ForwardTcp state unavailable");
  });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBeNull();
});

it("rejects an owning-gateway mismatch before the no-forward shortcut (#8942)", () => {
  mockLaunchForwardObservation(false);

  expect(areSandboxLaunchForwardsHealthy("beta", "ambient-sibling")).toBe(false);
  expect(forwardMocks.controller.inspect).not.toHaveBeenCalled();
});
