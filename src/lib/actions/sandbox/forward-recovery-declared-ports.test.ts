// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn((_args: string[], _options?: unknown) => ({ status: 0 })),
  getSessionAgent: vi.fn(),
  getSandbox: vi.fn(),
  getHermesDashboardRecoveryConfig: vi.fn(() => null),
  isLocalForwardReachable: vi.fn(() => true),
  launchForwardService: vi.fn(),
}));

vi.mock("../../adapters/openshell/forward-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/forward-service")>()),
  launchForwardService: mocks.launchForwardService,
}));

vi.mock("../../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/resolve")>()),
  resolveOpenshell: () => "/usr/local/bin/openshell",
}));

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  captureOpenshell: mocks.captureOpenshell,
  runOpenshell: mocks.runOpenshell,
  isCommandTimeout: () => false,
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

function forwardList(rows: string[]): { status: number; output: string } {
  return {
    status: 0,
    output: ["SANDBOX BIND PORT PID STATUS", ...rows].join("\n"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.runOpenshell.mockReturnValue({ status: 0 });
  mocks.isLocalForwardReachable.mockReturnValue(true);
  mocks.launchForwardService.mockImplementation(() => {
    mocks.isLocalForwardReachable.mockReturnValue(true);
  });
  mocks.getHermesDashboardRecoveryConfig.mockReturnValue(null);
  mocks.getSessionAgent.mockReturnValue(HERMES_AGENT);
});

describe("ensureDeclaredAgentForwardPortsHealthy", { timeout: 30_000 }, () => {
  it("accepts an already-reachable remote direct service during gateway recovery", async () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    mocks.getSandbox.mockReturnValue({
      agent: "openclaw",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
    });
    mocks.captureOpenshell.mockReturnValue(forwardList([]));
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("remote-box")).toBe(true);
    expect(mocks.launchForwardService).not.toHaveBeenCalled();
  });

  it("does not demand the manifest dashboard port from a sandbox that owns a different dashboard port (#8543)", async () => {
    mocks.getSandbox.mockReturnValue({
      agent: "hermes",
      dashboardPort: 18790,
      hermesApiPort: 8643,
    });
    mocks.captureOpenshell.mockReturnValue(
      forwardList(["alpha 127.0.0.1 18789 101 running", "alpha 127.0.0.1 8642 102 running"]),
    );
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18790)).toBe(true);
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });

  it("recovers the sandbox's own API port rather than the sibling sandbox's (#8543)", async () => {
    mocks.isLocalForwardReachable.mockReturnValue(false);
    mocks.getSandbox.mockReturnValue({
      agent: "hermes",
      dashboardPort: 18790,
      hermesApiPort: 8643,
    });
    mocks.captureOpenshell.mockReturnValue(
      forwardList(["alpha 127.0.0.1 18789 101 running", "alpha 127.0.0.1 8642 102 running"]),
    );
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18790)).toBe(true);
    expect(mocks.launchForwardService).toHaveBeenCalledWith(
      expect.objectContaining({ localPort: 8643, targetPort: 8643 }),
      {},
    );
  });

  it("pins declared forward inspection and recovery to the selected OpenShell target (#10514)", async () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    mocks.isLocalForwardReachable.mockReturnValue(false);
    mocks.getSandbox.mockReturnValue({
      agent: "hermes",
      dashboardPort: 18790,
      hermesApiPort: 8643,
    });
    mocks.captureOpenshell.mockReturnValue(forwardList([]));
    const runtimeSelection = {
      gatewayName: "nemoclaw-19080",
      workspace: "review-workspace",
      localTlsDir: "/authority/tls",
    };
    const selectedOptions = expect.objectContaining({
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: runtimeSelection.gatewayName,
        OPENSHELL_WORKSPACE: runtimeSelection.workspace,
        OPENSHELL_LOCAL_TLS_DIR: runtimeSelection.localTlsDir,
      }),
      replaceEnv: true,
    });
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");

    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18790, runtimeSelection)).toBe(true);
    expect(mocks.captureOpenshell).toHaveBeenCalledWith(
      ["forward", "list", "--gateway", runtimeSelection.gatewayName],
      selectedOptions,
    );
    expect(mocks.launchForwardService).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayName: runtimeSelection.gatewayName,
        localPort: 8643,
        sandboxName: "beta",
        targetPort: 8643,
        workspace: runtimeSelection.workspace,
      }),
      {
        sourceEnvironment: expect.objectContaining({
          OPENSHELL_GATEWAY: runtimeSelection.gatewayName,
          OPENSHELL_WORKSPACE: runtimeSelection.workspace,
          OPENSHELL_LOCAL_TLS_DIR: runtimeSelection.localTlsDir,
        }),
      },
    );
    const captureEnv = mocks.captureOpenshell.mock.calls[0]?.[1]?.env;
    expect(captureEnv).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(captureEnv).not.toHaveProperty("OPENSHELL_TOKEN");
    const sourceEnvironment = mocks.launchForwardService.mock.calls[0]?.[1]?.sourceEnvironment;
    expect(sourceEnvironment).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(sourceEnvironment).not.toHaveProperty("OPENSHELL_TOKEN");
  });

  it("keeps the default API port for a sandbox registered without one (#8543)", async () => {
    mocks.getSandbox.mockReturnValue({ agent: "hermes", dashboardPort: 18789 });
    mocks.captureOpenshell.mockReturnValue(forwardList([]));
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18789)).toBe(true);
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });
});
