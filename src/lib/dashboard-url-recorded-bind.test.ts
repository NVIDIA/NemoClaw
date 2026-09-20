// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ObserveOpenShellForwardsRequest,
  StartOpenShellForwardRequest,
} from "./adapters/openshell/forward";

const forward = vi.hoisted(() => ({
  createAdapter: vi.fn(),
  observeForwards: vi.fn(),
  startForward: vi.fn(),
  retireLegacyForward: vi.fn(),
  verifyForwardRelease: vi.fn(),
}));

// The recovery producer runs for real against the isolated registry below;
// only the OpenShell process boundary is stubbed.
vi.mock("./adapters/openshell/forward-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapters/openshell/forward-runtime")>()),
  createOpenShellForwardAdapterForAuthority: forward.createAdapter,
}));
vi.mock("./onboard/gateway-teardown-authority", () => ({
  resolveGatewayForwardAuthority: () => ({
    endpoint: "https://127.0.0.1:8080",
    gatewayName: "nemoclaw-8080",
    gatewayPort: 8080,
    localTlsDir: null,
  }),
}));
vi.mock("./agent/runtime", () => ({
  getSessionAgent: () => ({ forward_ports: [18789], forwardPort: 18789 }),
  hasGatewayRuntime: () => true,
}));
vi.mock("./actions/sandbox/hermes-dashboard-recovery", () => ({
  getHermesDashboardRecoveryConfig: () => null,
  ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
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

    await runDashboardUrlCommand(
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
  beforeEach(() => {
    vi.clearAllMocks();
    forward.startForward.mockReset();
    forward.observeForwards.mockReset();
    forward.observeForwards.mockImplementation(async (request: ObserveOpenShellForwardsRequest) =>
      request.forwards.map((item) => ({ state: "absent" as const, forward: item })),
    );
    forward.startForward.mockImplementation(async (request: StartOpenShellForwardRequest) => ({
      state: "started" as const,
      forward: request.forward,
      cleanup: vi.fn(async () => ({ state: "released" as const })),
    }));
    forward.createAdapter.mockReturnValue({
      observeForwards: forward.observeForwards,
      startForward: forward.startForward,
      retireLegacyForward: forward.retireLegacyForward,
      verifyForwardRelease: forward.verifyForwardRelease,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const home of createdHomes.splice(0)) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("discloses the wide bind recovery started with, from the row recovery wrote", async () => {
    await isolatedRegistryHome();
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
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

    await expect(recovery.ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(true);

    expect(forward.startForward).toHaveBeenCalledWith({
      forward: expect.objectContaining({ localHost: "0.0.0.0", port: 18789 }),
      assertCurrent: expect.any(Function),
    });
    expect(registry.getSandbox("hm")?.dashboardBindAddress).toBe("0.0.0.0");
    const out: string[] = [];
    await runDashboardUrlCommand(
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
