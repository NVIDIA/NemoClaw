// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, expect, it, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const { areSandboxLaunchForwardsHealthy } = requireSource(
  "../src/lib/actions/sandbox/forward-recovery.ts",
) as typeof import("../src/lib/actions/sandbox/forward-recovery.js");

afterEach(() => {
  vi.restoreAllMocks();
});

it("checks launch forwards through the sandbox's owning gateway without repair (#8942)", () => {
  const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
  const agentRuntime = requireSource("../src/lib/agent/runtime.js");
  const registry = requireSource("../src/lib/state/registry.js");
  const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    runtime: { kind: "gateway" },
    forward_ports: [18790],
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "beta",
    agent: "openclaw",
    dashboardPort: 18789,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  });
  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
  const capture = vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
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
