// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const forward = vi.hoisted(() => ({
  launchForwardService: vi.fn(),
  isLocalForwardReachable: vi.fn(() => false),
}));

// The recovery producer runs for real against the isolated registry below;
// only the OpenShell process boundary is stubbed.
vi.mock("./adapters/openshell/forward-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapters/openshell/forward-service")>()),
  isForwardServiceListenerOwner: () => true,
  launchForwardService: forward.launchForwardService,
}));
vi.mock("./adapters/openshell/resolve", () => ({
  resolveOpenshell: () => "/usr/local/bin/openshell",
}));
vi.mock("./adapters/openshell/runtime", () => ({
  captureOpenshell: () => ({ status: 0, output: "SANDBOX BIND PORT PID STATUS" }),
  runOpenshell: () => ({ status: 0 }),
  isCommandTimeout: () => false,
}));
vi.mock("./agent/runtime", () => ({
  getSessionAgent: () => ({ forward_ports: [18789], forwardPort: 18789 }),
  hasGatewayRuntime: () => true,
}));
vi.mock("./actions/sandbox/hermes-dashboard-recovery", () => ({
  getHermesDashboardRecoveryConfig: () => null,
  ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
}));
vi.mock("./actions/sandbox/forward-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions/sandbox/forward-health")>()),
  isLocalForwardReachable: forward.isLocalForwardReachable,
}));

const SSH_SESSION = { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" };

const createdHomes: string[] = [];

/**
 * Point the real registry at a private state root. A forward launch records
 * the bind through `updateSandbox`; `dashboard-url` reads it back through
 * `getSandbox`. Nothing between them is mocked.
 */
async function isolatedRegistryHome(): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-dashboard-bind-"));
  createdHomes.push(home);
  vi.stubEnv("HOME", home);
  vi.resetModules();
}

describe("dashboard-url reads the bind a forward launch recorded in the registry (#10861)", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const home of createdHomes.splice(0)) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("discloses a persisted wide bind and withholds the SSH forward hint", async () => {
    await isolatedRegistryHome();
    const registry = await import("./state/registry");
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      dashboardPort: 18792,
      gatewayName: "nemoclaw-8080",
      gatewayPort: 8080,
    });
    expect(registry.updateSandbox("alpha", { dashboardBindAddress: "0.0.0.0" })).toBe(true);
    const { runDashboardUrlCommand } = await import("./dashboard-url-command");
    const out: string[] = [];

    runDashboardUrlCommand(
      "alpha",
      { quiet: false },
      {
        fetchToken: () => "secret-token",
        getSandbox: registry.getSandbox,
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
        log: (message) => out.push(message),
        error: () => undefined,
      },
    );

    expect(out).toEqual([
      "  Dashboard URL:",
      "  http://127.0.0.1:18792/#token=secret-token",
      "  Bound on all interfaces (0.0.0.0:18792); other hosts may reach it at this host's address, subject to the host firewall.",
    ]);
  });
});

describe("a recovery launch records the bind that dashboard-url then reports (#10861)", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    forward.launchForwardService.mockReset();
    forward.isLocalForwardReachable.mockReset().mockReturnValue(false);
    for (const home of createdHomes.splice(0)) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("discloses the wide bind recovery started with, from the row recovery wrote", async () => {
    await isolatedRegistryHome();
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    forward.launchForwardService.mockImplementation(() => {
      forward.isLocalForwardReachable.mockReturnValue(true);
    });
    const registry = await import("./state/registry");
    registry.registerSandbox({
      name: "hm",
      agent: "hermes",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
      gatewayName: "nemoclaw-8080",
      gatewayPort: 8080,
    });
    const recovery = await import("./actions/sandbox/forward-recovery");
    const { runDashboardUrlCommand } = await import("./dashboard-url-command");

    expect(recovery.ensureSandboxPortForward("hm", { isWsl: false })).toBe(true);

    expect(forward.launchForwardService).toHaveBeenCalledWith(
      expect.objectContaining({ localHost: "0.0.0.0", localPort: 18789 }),
      expect.anything(),
    );
    expect(registry.getSandbox("hm")?.dashboardBindAddress).toBe("0.0.0.0");
    const out: string[] = [];
    runDashboardUrlCommand(
      "hm",
      { quiet: false },
      {
        fetchToken: () => "unused",
        getSandbox: registry.getSandbox,
        getAgentDashboardAuth: () => "session",
        env: SSH_SESSION,
        log: (message) => out.push(message),
        error: () => undefined,
      },
    );
    expect(out).toEqual([
      "  Dashboard URL:",
      "  http://127.0.0.1:18789/",
      "  Bound on all interfaces (0.0.0.0:18789); other hosts may reach it at this host's address, subject to the host firewall.",
    ]);
  });
});
