// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import * as forwardHealth from "../src/lib/actions/sandbox/forward-health.ts";
import { areSandboxLaunchForwardsHealthy } from "../src/lib/actions/sandbox/forward-recovery.ts";
import * as openshellRuntime from "../src/lib/adapters/openshell/runtime.ts";
import * as agentRuntime from "../src/lib/agent/runtime.ts";
import * as registry from "../src/lib/state/registry.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockLaunchForwardObservation(
  result: { status: number | null; output: string },
  reachable = true,
  gatewayRuntime = true,
) {
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    runtime: { kind: gatewayRuntime ? "gateway" : "terminal" },
    forward_ports: [18790],
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "beta",
    agent: "openclaw",
    dashboardPort: 18789,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  });
  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(reachable);
  return vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue(result);
}

it("checks launch forwards through the sandbox's owning gateway without repair (#8942)", () => {
  const capture = mockLaunchForwardObservation({
    status: 0,
    output: `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running
beta  127.0.0.1  18790  12346  running`,
  });

  expect(areSandboxLaunchForwardsHealthy("beta")).toBe(true);
  expect(capture).toHaveBeenCalledOnce();
  expect(capture).toHaveBeenCalledWith(["forward", "list", "--gateway", "nemoclaw"], {
    ignoreError: true,
    timeout: expect.any(Number),
  });
});

it("rejects a reachable listener when the owning forward row is missing (#8942)", () => {
  mockLaunchForwardObservation({
    status: 0,
    output: "SANDBOX  BIND  PORT  PID  STATUS",
  });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBe(false);
});

it("returns unknown when the owner-scoped forward observation fails (#8942)", () => {
  mockLaunchForwardObservation({ status: 1, output: "" });

  expect(areSandboxLaunchForwardsHealthy("beta", "nemoclaw")).toBeNull();
});

it("rejects an owning-gateway mismatch before the no-forward shortcut (#8942)", () => {
  const capture = mockLaunchForwardObservation({ status: 0, output: "" }, true, false);

  expect(areSandboxLaunchForwardsHealthy("beta", "ambient-sibling")).toBe(false);
  expect(capture).not.toHaveBeenCalled();
});
