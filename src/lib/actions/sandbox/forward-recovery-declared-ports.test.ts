// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  captureResolvedOpenshell: vi.fn(),
  runOpenshell: vi.fn((_args: string[], _options?: unknown) => ({ status: 0 })),
  getSessionAgent: vi.fn(),
  getSandbox: vi.fn(),
  getHermesDashboardRecoveryConfig: vi.fn(() => null),
  isLocalForwardReachable: vi.fn(() => true),
  isForwardServiceListenerOwner: vi.fn(() => true),
  launchForwardService: vi.fn(),
  resolveGatewayForwardAuthority: vi.fn(),
}));

vi.mock("../../adapters/openshell/forward-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/forward-service")>()),
  isForwardServiceListenerOwner: mocks.isForwardServiceListenerOwner,
  launchForwardService: mocks.launchForwardService,
}));

vi.mock("../../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/resolve")>()),
  resolveOpenshell: () => "/usr/local/bin/openshell",
}));

vi.mock("../../onboard/gateway-teardown-authority", () => ({
  resolveGatewayForwardAuthority: mocks.resolveGatewayForwardAuthority,
}));

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  captureOpenshell: mocks.captureOpenshell,
  captureResolvedOpenshell: mocks.captureResolvedOpenshell,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.runOpenshell.mockReturnValue({ status: 0 });
  mocks.captureResolvedOpenshell.mockReturnValue({
    status: 0,
    output: "No active forwards.",
  });
  mocks.isLocalForwardReachable.mockReturnValue(true);
  mocks.isForwardServiceListenerOwner.mockReturnValue(true);
  mocks.launchForwardService.mockImplementation(() => {
    mocks.isLocalForwardReachable.mockReturnValue(true);
  });
  mocks.getHermesDashboardRecoveryConfig.mockReturnValue(null);
  mocks.getSessionAgent.mockReturnValue(HERMES_AGENT);
  mocks.resolveGatewayForwardAuthority.mockImplementation(
    ({ gatewayName, gatewayPort }: { gatewayName: string; gatewayPort: number }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  );
});

function externalGatewayOwner(
  endpoint: string,
  stateDir = "/external/gateway",
  execPath = "/usr/local/bin/openshell-gateway",
) {
  return {
    gatewayName: "nemoclaw-19080",
    gatewayPort: 19080,
    mode: "externally-supervised" as const,
    source: "declared" as const,
    endpoint,
    stateDir,
    supervisor: {
      kind: "systemd-system" as const,
      serviceName: "openshell-gateway.service",
      execPath,
    },
    requiredCapabilities: [],
  };
}

describe("Hermes portable direct forward authority", { timeout: 30_000 }, () => {
  it.each([
    { endpoint: "http://127.0.0.1:19080", expectedTlsDir: undefined },
    { endpoint: "https://[::1]:19080", expectedTlsDir: "/external/gateway/tls" },
  ])(
    "launches against the exact external endpoint $endpoint",
    async ({ endpoint, expectedTlsDir }) => {
      mocks.resolveGatewayForwardAuthority.mockReturnValue(externalGatewayOwner(endpoint));
      const { createHermesPortableForwardRecoveryInput } = await import("./forward-recovery");
      const input = createHermesPortableForwardRecoveryInput({
        assertCurrent: vi.fn(),
        assertRollbackCurrent: vi.fn(),
        commandAuthority: {
          env: {
            HOME: "/portable/home",
            OPENSHELL_LOCAL_TLS_DIR: "/ambient/hostile/tls",
            OPENSHELL_TOKEN: "ambient-hostile-token",
          },
          executablePath: "/usr/local/bin/openshell",
        },
        gatewayName: "nemoclaw-19080",
        intent: "connect-probe-only",
        onTiming: vi.fn(),
        ports: [18_789],
        sandboxName: "hermes-box",
      });

      expect(input.forwardService).toMatchObject({
        executablePath: "/usr/local/bin/openshell",
        gatewayEndpoint: endpoint,
        workspace: "default",
      });
      const sourceEnvironment = input.forwardService.sourceEnvironment;
      expect(sourceEnvironment).toMatchObject({
        HOME: "/portable/home",
        OPENSHELL_GATEWAY: "nemoclaw-19080",
        OPENSHELL_WORKSPACE: "default",
      });
      expect(sourceEnvironment?.OPENSHELL_LOCAL_TLS_DIR).toBe(expectedTlsDir);
      expect(sourceEnvironment).not.toHaveProperty("OPENSHELL_TOKEN");
    },
  );

  it("rejects full gateway-owner drift after composition", async () => {
    mocks.resolveGatewayForwardAuthority
      .mockReturnValueOnce(externalGatewayOwner("http://127.0.0.1:19080"))
      .mockReturnValue(
        externalGatewayOwner(
          "http://127.0.0.1:19080",
          "/external/gateway",
          "/usr/local/bin/replacement-gateway",
        ),
      );
    const { createHermesPortableForwardRecoveryInput } = await import("./forward-recovery");
    const input = createHermesPortableForwardRecoveryInput({
      assertCurrent: vi.fn(),
      assertRollbackCurrent: vi.fn(),
      commandAuthority: { env: { HOME: "/portable/home" }, executablePath: "/usr/bin/openshell" },
      gatewayName: "nemoclaw-19080",
      intent: "connect-probe-only",
      onTiming: vi.fn(),
      ports: [18_789],
      sandboxName: "hermes-box",
    });

    expect(() => input.deps.assertCurrent()).toThrow(/gateway authority changed/u);
  });
});

describe("ensureDeclaredAgentForwardPortsHealthy", { timeout: 30_000 }, () => {
  it("accepts an already-reachable remote direct service during gateway recovery", async () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    mocks.getSandbox.mockReturnValue({
      agent: "openclaw",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
    });
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("remote-box")).toBe(true);
    expect(mocks.isForwardServiceListenerOwner).toHaveBeenCalledWith({
      executable: "/usr/local/bin/openshell",
      gatewayEndpoint: "https://127.0.0.1:8080",
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
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18790)).toBe(true);
    expect(mocks.launchForwardService).toHaveBeenCalledWith(
      expect.objectContaining({ localPort: 8643, targetPort: 8643 }),
      expect.objectContaining({ verifyReady: expect.any(Function) }),
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
    const runtimeSelection = {
      gatewayName: "nemoclaw-19080",
      workspace: "review-workspace",
      localTlsDir: "/authority/tls",
    };
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");

    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18790, runtimeSelection)).toBe(true);
    expect(mocks.launchForwardService).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayEndpoint: "https://127.0.0.1:19080",
        gatewayName: runtimeSelection.gatewayName,
        localPort: 8643,
        sandboxName: "beta",
        targetPort: 8643,
        workspace: runtimeSelection.workspace,
      }),
      expect.objectContaining({
        sourceEnvironment: expect.objectContaining({
          OPENSHELL_GATEWAY: runtimeSelection.gatewayName,
          OPENSHELL_WORKSPACE: runtimeSelection.workspace,
          OPENSHELL_LOCAL_TLS_DIR: runtimeSelection.localTlsDir,
        }),
        verifyReady: expect.any(Function),
      }),
    );
    const sourceEnvironment = mocks.launchForwardService.mock.calls[0]?.[1]?.sourceEnvironment;
    expect(sourceEnvironment).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(sourceEnvironment).not.toHaveProperty("OPENSHELL_TOKEN");
  });

  it.each([
    { endpoint: "http://127.0.0.1:19080", expectedTlsDir: undefined },
    { endpoint: "https://[::1]:19080", expectedTlsDir: "/external/gateway/tls" },
  ])(
    "uses the revalidated external gateway endpoint $endpoint for recovery",
    async ({ endpoint, expectedTlsDir }) => {
      mocks.isLocalForwardReachable.mockReturnValue(false);
      mocks.getSandbox.mockReturnValue({
        agent: "hermes",
        dashboardPort: 18790,
        gatewayPort: 19080,
        hermesApiPort: 8643,
      });
      mocks.resolveGatewayForwardAuthority.mockReturnValue(externalGatewayOwner(endpoint));
      mocks.launchForwardService.mockImplementation((_target, options) => options.verifyReady?.());
      const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");

      expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18790)).toBe(true);
      expect(mocks.launchForwardService).toHaveBeenCalledWith(
        expect.objectContaining({
          gatewayEndpoint: endpoint,
          gatewayName: "nemoclaw-19080",
          localPort: 8643,
        }),
        expect.objectContaining({ verifyReady: expect.any(Function) }),
      );
      const sourceEnvironment = mocks.launchForwardService.mock.calls[0]?.[1]?.sourceEnvironment;
      expect(sourceEnvironment?.OPENSHELL_LOCAL_TLS_DIR).toBe(expectedTlsDir);
    },
  );

  it("keeps the default API port for a sandbox registered without one (#8543)", async () => {
    mocks.getSandbox.mockReturnValue({ agent: "hermes", dashboardPort: 18789 });
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");
    expect(ensureDeclaredAgentForwardPortsHealthy("beta", 18789)).toBe(true);
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });
});

describe("a dashboard port held by a listener the sandbox does not own (#11149)", () => {
  beforeEach(() => {
    mocks.getSessionAgent.mockReturnValue(null);
    mocks.getSandbox.mockReturnValue({ agent: "openclaw", dashboardPort: 18789 });
  });

  it.each([
    ["nothing listens", () => mocks.isLocalForwardReachable.mockReturnValue(false), "absent"],
    [
      "an unverified legacy SSH listener answers",
      () => mocks.isForwardServiceListenerOwner.mockReturnValue(false),
      "unverified",
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
    expect(message).toContain("NemoClaw cannot prove it started the listener");
    expect(message).not.toContain("NemoClaw did not start it");
    expect(message).toContain("nemoclaw box recover");
  });

  it("never accepts legacy registry metadata as listener ownership evidence", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.isForwardServiceListenerOwner.mockReturnValue(false);
    mocks.captureOpenshell.mockReturnValue({
      status: 0,
      output: "SANDBOX BIND PORT PID STATUS\nbox 127.0.0.1 18789 4242 running",
    });
    const afterSuccess = vi.fn(() => true);
    const { isSandboxForwardHealthy, ensureSandboxPortForward } =
      await import("./forward-recovery");

    expect(isSandboxForwardHealthy("box", { isWsl: false })).toBe(false);
    expect(ensureSandboxPortForward("box", { afterSuccess, isWsl: false })).toBe(false);
    expect(afterSuccess).not.toHaveBeenCalled();
    expect(mocks.captureOpenshell).not.toHaveBeenCalled();
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
    expect(mocks.launchForwardService).not.toHaveBeenCalled();
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Host port 18789 for 'box' is held by a listener",
    );
  });

  it("relaunches with a sanitized default target when nothing listens", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    mocks.isLocalForwardReachable.mockReturnValue(false);
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(true);

    expect(mocks.launchForwardService).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayName: "nemoclaw", workspace: "default" }),
      expect.objectContaining({
        sourceEnvironment: expect.objectContaining({
          OPENSHELL_GATEWAY: "nemoclaw",
          OPENSHELL_WORKSPACE: "default",
        }),
        verifyReady: expect.any(Function),
      }),
    );
    const sourceEnvironment = mocks.launchForwardService.mock.calls[0]?.[1]?.sourceEnvironment;
    expect(sourceEnvironment).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(sourceEnvironment).not.toHaveProperty("OPENSHELL_LOCAL_TLS_DIR");
    expect(sourceEnvironment).not.toHaveProperty("OPENSHELL_TOKEN");
  });

  it("rejects a foreign listener that wins the bind after the vacancy check", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.isLocalForwardReachable.mockReturnValue(false);
    mocks.launchForwardService.mockImplementation((_target, options) => {
      mocks.isForwardServiceListenerOwner.mockReturnValue(false);
      options.verifyReady?.();
    });
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);
    expect(mocks.launchForwardService).toHaveBeenCalledOnce();
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects gateway endpoint drift after the forward binds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getSandbox.mockReturnValue({
      agent: "openclaw",
      dashboardPort: 18789,
      gatewayPort: 19080,
    });
    mocks.isLocalForwardReachable.mockReturnValue(false);
    mocks.resolveGatewayForwardAuthority
      .mockReturnValueOnce(externalGatewayOwner("http://127.0.0.1:19080"))
      .mockReturnValueOnce(externalGatewayOwner("https://[::1]:19080"));
    mocks.launchForwardService.mockImplementation((_target, options) => options.verifyReady?.());
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);
    expect(mocks.launchForwardService).toHaveBeenCalledOnce();
    expect(mocks.isForwardServiceListenerOwner).not.toHaveBeenCalled();
  });

  it("rejects TLS authority drift after exact ownership succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getSandbox.mockReturnValue({
      agent: "openclaw",
      dashboardPort: 18789,
      gatewayPort: 19080,
    });
    mocks.isLocalForwardReachable.mockReturnValue(false);
    mocks.resolveGatewayForwardAuthority
      .mockReturnValueOnce(externalGatewayOwner("https://[::1]:19080"))
      .mockReturnValueOnce(externalGatewayOwner("https://[::1]:19080"))
      .mockReturnValueOnce(externalGatewayOwner("https://[::1]:19080", "/replacement/gateway"));
    mocks.launchForwardService.mockImplementation((_target, options) => options.verifyReady?.());
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);
    expect(mocks.launchForwardService).toHaveBeenCalledOnce();
    expect(mocks.isForwardServiceListenerOwner).toHaveBeenCalledOnce();
  });

  it("does not accept ownership when gateway authority drifts during the proof", async () => {
    mocks.getSandbox.mockReturnValue({
      agent: "openclaw",
      dashboardPort: 18789,
      gatewayPort: 19080,
    });
    mocks.resolveGatewayForwardAuthority
      .mockReturnValueOnce(externalGatewayOwner("http://127.0.0.1:19080"))
      .mockReturnValueOnce(externalGatewayOwner("https://[::1]:19080"));
    const { describeSandboxForwardListener } = await import("./forward-recovery");

    expect(describeSandboxForwardListener("box", { isWsl: false })).toBe("unverified");
    expect(mocks.isForwardServiceListenerOwner).toHaveBeenCalledOnce();
  });

  it("fails cleanly when reachable-listener authority cannot be resolved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.resolveGatewayForwardAuthority.mockImplementation(() => {
      throw new Error("authority unavailable");
    });
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);
    expect(mocks.isForwardServiceListenerOwner).not.toHaveBeenCalled();
    expect(mocks.launchForwardService).not.toHaveBeenCalled();
  });

  it("fails cleanly when vacant-port launch authority cannot be resolved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.isLocalForwardReachable.mockReturnValue(false);
    mocks.resolveGatewayForwardAuthority.mockImplementation(() => {
      throw new Error("authority unavailable");
    });
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    expect(ensureSandboxPortForward("box", { isWsl: false })).toBe(false);
    expect(mocks.isForwardServiceListenerOwner).not.toHaveBeenCalled();
    expect(mocks.launchForwardService).not.toHaveBeenCalled();
  });
});
