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
  isForwardServiceListenerOwner: vi.fn(() => true),
  launchForwardService: vi.fn(),
  localListenerPids: vi.fn(() => ["4242"]),
  isListenerProcessExecutable: vi.fn(() => true),
}));

vi.mock("../../adapters/openshell/forward-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/forward-service")>()),
  isForwardServiceListenerOwner: mocks.isForwardServiceListenerOwner,
  launchForwardService: mocks.launchForwardService,
  localListenerPids: mocks.localListenerPids,
  isListenerProcessExecutable: mocks.isListenerProcessExecutable,
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
  mocks.isForwardServiceListenerOwner.mockReturnValue(true);
  mocks.localListenerPids.mockReturnValue(["4242"]);
  mocks.isListenerProcessExecutable.mockReturnValue(true);
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
    expect(mocks.isForwardServiceListenerOwner).toHaveBeenCalledWith({
      executable: "/usr/local/bin/openshell",
      gatewayName: "nemoclaw",
      workspace: "default",
      sandboxName: "remote-box",
      localHost: "0.0.0.0",
      localPort: 18_789,
      targetHost: "127.0.0.1",
      targetPort: 18_789,
    });
    expect(mocks.launchForwardService).not.toHaveBeenCalled();
  });

  it("fails closed without a launch attempt when reachable direct service ownership cannot be proved (#11149)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getSandbox.mockReturnValue({ agent: "openclaw", dashboardPort: 18_789 });
    mocks.captureOpenshell.mockReturnValue(forwardList([]));
    mocks.isForwardServiceListenerOwner.mockReturnValue(false);
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("foreign-listener")).toBe(false);
    expect(mocks.isForwardServiceListenerOwner).toHaveBeenCalledOnce();
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

describe("a dashboard port held by a listener the sandbox does not own (#11149)", () => {
  beforeEach(() => {
    mocks.getSessionAgent.mockReturnValue(null);
    mocks.getSandbox.mockReturnValue({ agent: "openclaw", dashboardPort: 18789 });
    mocks.captureOpenshell.mockReturnValue(forwardList([]));
  });

  it.each([
    ["nothing listens", () => mocks.isLocalForwardReachable.mockReturnValue(false), "absent"],
    [
      "a tracked legacy forward listens",
      () =>
        mocks.captureOpenshell.mockReturnValue(
          forwardList(["box  127.0.0.1  18789  4242  running"]),
        ),
      "legacy",
    ],
    ["the sandbox's own ForwardTcp service listens", () => undefined, "owned"],
    [
      "an unrelated process listens",
      () => mocks.isForwardServiceListenerOwner.mockReturnValue(false),
      "unverified",
    ],
  ])("describes the listener when %s", async (_case, arrange, expected) => {
    arrange();
    const { describeSandboxForwardListener } = await import("./forward-recovery");

    expect(describeSandboxForwardListener("box", { isWsl: false })).toBe(expected);
  });

  it("refuses to relaunch onto it, names the port and leaves it running", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.isForwardServiceListenerOwner.mockReturnValue(false);
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);

    expect(mocks.launchForwardService).not.toHaveBeenCalled();
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
    const message = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(message).toContain(
      "Host port 18789 for 'box' is held by a listener that NemoClaw cannot attribute to this sandbox's OpenShell forward",
    );
    expect(message).toContain("nemoclaw box recover");
  });

  it("treats a stale legacy row over a listener it cannot attribute as unverified", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.captureOpenshell.mockReturnValue(forwardList(["box  127.0.0.1  18789  4242  running"]));
    mocks.localListenerPids.mockReturnValue(["9999"]);
    const { describeSandboxForwardListener, ensureSandboxPortForward } =
      await import("./forward-recovery");

    expect(describeSandboxForwardListener("box", { isWsl: false })).toBe("unverified");
    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);

    expect(mocks.runOpenshell).not.toHaveBeenCalled();
    expect(mocks.launchForwardService).not.toHaveBeenCalled();
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Host port 18789 for 'box' is held by a listener",
    );
  });

  it("treats a running legacy row whose PID runs another executable as unverified", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.captureOpenshell.mockReturnValue(forwardList(["box  127.0.0.1  18789  4242  running"]));
    mocks.isListenerProcessExecutable.mockReturnValue(false);
    const { describeSandboxForwardListener, ensureSandboxPortForward } =
      await import("./forward-recovery");

    expect(describeSandboxForwardListener("box", { isWsl: false })).toBe("unverified");
    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);

    expect(mocks.runOpenshell).not.toHaveBeenCalled();
    expect(mocks.launchForwardService).not.toHaveBeenCalled();
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Host port 18789 for 'box' is held by a listener",
    );
  });

  it("treats a dead legacy row whose PID matches the listener as unverified", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.captureOpenshell.mockReturnValue(forwardList(["box  127.0.0.1  18789  4242  dead"]));
    const { describeSandboxForwardListener, ensureSandboxPortForward } =
      await import("./forward-recovery");

    expect(describeSandboxForwardListener("box", { isWsl: false })).toBe("unverified");
    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);

    expect(mocks.runOpenshell).not.toHaveBeenCalled();
    expect(mocks.launchForwardService).not.toHaveBeenCalled();
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Host port 18789 for 'box' is held by a listener",
    );
  });

  it("still relaunches when nothing listens", async () => {
    mocks.isLocalForwardReachable.mockReturnValue(false);
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(true);

    expect(mocks.launchForwardService).toHaveBeenCalledOnce();
  });
});
