// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ObserveOpenShellForwardsRequest,
  OpenShellForwardIdentity,
  OpenShellForwardObservation,
  RetireLegacyOpenShellForwardRequest,
  StartOpenShellForwardRequest,
  VerifyOpenShellForwardReleaseRequest,
} from "../../adapters/openshell/forward";
import { OPENSHELL_HEAVY_TIMEOUT_MS } from "../../adapters/openshell/timeouts";

const mocks = vi.hoisted(() => ({
  createAdapter: vi.fn(),
  getHermesDashboardRecoveryConfig: vi.fn(() => null),
  getRegisteredAgent: vi.fn(),
  getSessionAgent: vi.fn(),
  getSandbox: vi.fn(),
  observeForwards: vi.fn(),
  resolveGatewayForwardAuthority: vi.fn(),
  resolveGatewayForwardRuntimeAuthority: vi.fn(),
  retireLegacyForward: vi.fn(),
  startForward: vi.fn(),
  verifyForwardRelease: vi.fn(),
}));

vi.mock("../../adapters/openshell/forward-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/forward-runtime")>()),
  createOpenShellForwardAdapterForAuthority: mocks.createAdapter,
}));

vi.mock("../../onboard/gateway-teardown-authority", () => ({
  resolveGatewayForwardAuthority: mocks.resolveGatewayForwardAuthority,
}));

vi.mock("../../onboard/gateway-host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/gateway-host-runtime")>()),
  resolveGatewayForwardRuntimeAuthority: mocks.resolveGatewayForwardRuntimeAuthority,
}));

vi.mock("../../agent/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/runtime")>()),
  getRegisteredAgent: mocks.getRegisteredAgent,
  getSessionAgent: mocks.getSessionAgent,
  hasGatewayRuntime: (agent: { runtime?: { kind?: string } } | null) =>
    agent?.runtime?.kind !== "terminal",
}));

vi.mock("../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/registry")>()),
  getSandbox: mocks.getSandbox,
}));

vi.mock("./hermes-dashboard-recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hermes-dashboard-recovery")>()),
  getHermesDashboardRecoveryConfig: mocks.getHermesDashboardRecoveryConfig,
}));

const HERMES_AGENT = {
  name: "hermes",
  runtime: { kind: "gateway" },
  forward_ports: [18_789, 8_642],
  forwardPort: 18_789,
};

const states = new Map<number, OpenShellForwardObservation["state"]>();

function observation(
  forward: OpenShellForwardIdentity,
  state: OpenShellForwardObservation["state"],
): OpenShellForwardObservation {
  return state === "indeterminate"
    ? {
        state,
        forward,
        error: {
          kind: "ownership",
          message: "NemoClaw could not prove OpenShell forward ownership.",
        },
      }
    : { state, forward };
}

function managedGatewayOwner(gatewayName = "nemoclaw", gatewayPort = 8_080) {
  return {
    gatewayName,
    gatewayPort,
    mode: "nemoclaw-managed" as const,
    source: "standalone" as const,
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  };
}

function sandboxEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "box",
    agent: "openclaw",
    dashboardPort: 18_789,
    gatewayName: "nemoclaw",
    gatewayPort: 8_080,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  states.clear();
  mocks.getSandbox.mockReturnValue(sandboxEntry());
  mocks.getSessionAgent.mockReturnValue(HERMES_AGENT);
  mocks.getRegisteredAgent.mockReturnValue(HERMES_AGENT);
  mocks.getHermesDashboardRecoveryConfig.mockReturnValue(null);
  mocks.resolveGatewayForwardAuthority.mockImplementation(
    ({ gatewayName, gatewayPort }: { gatewayName: string; gatewayPort: number }) =>
      managedGatewayOwner(gatewayName, gatewayPort),
  );
  mocks.resolveGatewayForwardRuntimeAuthority.mockImplementation(
    (owner: { endpoint?: string | null; gatewayName: string; gatewayPort: number }) => ({
      gatewayEndpoint: owner.endpoint ?? `https://127.0.0.1:${String(owner.gatewayPort)}`,
      gatewayName: owner.gatewayName,
      workspace: "default",
    }),
  );
  mocks.observeForwards.mockImplementation(async (request: ObserveOpenShellForwardsRequest) => {
    await request.assertCurrent?.();
    const result = request.forwards.map((forward) =>
      observation(forward, states.get(forward.port) ?? "owned"),
    );
    await request.assertCurrent?.();
    return result;
  });
  mocks.startForward.mockImplementation(async (request: StartOpenShellForwardRequest) => {
    await request.assertCurrent?.();
    states.set(request.forward.port, "owned");
    await request.assertCurrent?.();
    return {
      state: "started",
      forward: request.forward,
      cleanup: vi.fn(async () => ({ state: "released" as const })),
    };
  });
  mocks.retireLegacyForward.mockImplementation(
    async (request: RetireLegacyOpenShellForwardRequest) => {
      await request.assertCurrent?.();
      await request.authorize(request.forward);
      states.set(request.forward.port, "absent");
      await request.assertCurrent?.();
      return { state: "retired", forward: request.forward };
    },
  );
  mocks.verifyForwardRelease.mockImplementation(
    async (request: VerifyOpenShellForwardReleaseRequest) => {
      await request.assertCurrent?.();
      return { state: "released" };
    },
  );
  mocks.createAdapter.mockReturnValue({
    observeForwards: mocks.observeForwards,
    retireLegacyForward: mocks.retireLegacyForward,
    startForward: mocks.startForward,
    verifyForwardRelease: mocks.verifyForwardRelease,
  });
});

describe("Hermes portable direct forward authority", { timeout: 30_000 }, () => {
  it("binds every requested forward to the exact executable and gateway authority", async () => {
    const { createHermesPortableForwardRecoveryInput } = await import("./forward-recovery");
    const input = createHermesPortableForwardRecoveryInput({
      assertCurrent: vi.fn(),
      assertRollbackCurrent: vi.fn(),
      commandAuthority: {
        env: { HOME: "/portable/home", OPENSHELL_TOKEN: "ambient-secret" },
        executablePath: "/usr/local/bin/openshell",
      },
      gatewayName: "nemoclaw",
      intent: "connect-probe-only",
      onTiming: vi.fn(),
      ports: [18_789, 8_642],
      sandboxName: "hermes-box",
    });

    expect(input.forwards).toEqual([
      expect.objectContaining({ sandboxName: "hermes-box", port: 18_789 }),
      expect.objectContaining({ sandboxName: "hermes-box", port: 8_642 }),
    ]);
    expect(input.operationTimeoutMs).toBe(OPENSHELL_HEAVY_TIMEOUT_MS);
    expect(mocks.createAdapter).toHaveBeenCalledWith(
      {
        gatewayEndpoint: "https://127.0.0.1:8080",
        gatewayName: "nemoclaw",
        workspace: "default",
      },
      {
        environment: expect.objectContaining({ HOME: "/portable/home" }),
        executable: "/usr/local/bin/openshell",
      },
    );
    expect(input.deps.adapter).toEqual(mocks.createAdapter.mock.results[0]?.value);
  });

  it("rejects gateway owner drift after composition", async () => {
    const { createHermesPortableForwardRecoveryInput } = await import("./forward-recovery");
    const assertCurrent = vi.fn();
    const input = createHermesPortableForwardRecoveryInput({
      assertCurrent,
      assertRollbackCurrent: vi.fn(),
      commandAuthority: { env: {}, executablePath: "/usr/local/bin/openshell" },
      gatewayName: "nemoclaw",
      intent: "connect-probe-only",
      onTiming: vi.fn(),
      ports: [18_789],
      sandboxName: "hermes-box",
    });
    mocks.resolveGatewayForwardAuthority.mockReturnValue(managedGatewayOwner("nemoclaw", 19_080));

    expect(() => input.deps.assertCurrent()).toThrow(/gateway authority changed/u);
    expect(assertCurrent).toHaveBeenCalled();
  });
});

describe("forward recovery through the typed adapter", () => {
  it("reuses an exact owned dashboard forward", async () => {
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    await expect(ensureSandboxPortForward("box", { isWsl: false })).resolves.toBe(true);
    expect(mocks.observeForwards).toHaveBeenCalledOnce();
    expect(mocks.startForward).not.toHaveBeenCalled();
  });

  it.each(["foreign", "indeterminate"] as const)(
    "refuses a %s dashboard listener with zero mutation attempts",
    async (state) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      states.set(18_789, state);
      const { ensureSandboxPortForward } = await import("./forward-recovery");

      await expect(ensureSandboxPortForward("box", { isWsl: false })).resolves.toBe(false);
      expect(mocks.startForward).not.toHaveBeenCalled();
      expect(mocks.retireLegacyForward).not.toHaveBeenCalled();
    },
  );

  it("starts exactly once when the dashboard forward is absent", async () => {
    states.set(18_789, "absent");
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    await expect(ensureSandboxPortForward("box", { isWsl: false })).resolves.toBe(true);
    expect(mocks.startForward).toHaveBeenCalledOnce();
    expect(mocks.retireLegacyForward).not.toHaveBeenCalled();
  });

  it("retires one exact stale legacy forward before one replacement start", async () => {
    states.set(18_789, "stale");
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    await expect(ensureSandboxPortForward("box", { isWsl: false })).resolves.toBe(true);
    expect(mocks.retireLegacyForward).toHaveBeenCalledOnce();
    expect(mocks.startForward).toHaveBeenCalledOnce();
    expect(mocks.retireLegacyForward.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startForward.mock.invocationCallOrder[0]!,
    );
  });

  it("returns the adapter's explicit observation state", async () => {
    states.set(18_789, "stale");
    const { describeSandboxForwardListener } = await import("./forward-recovery");

    await expect(describeSandboxForwardListener("box", { isWsl: false })).resolves.toBe("stale");
  });

  it("preserves an all-interface identity for a prepared remote dashboard", async () => {
    mocks.getSandbox.mockReturnValue(sandboxEntry({ dashboardRemoteBindPrepared: true }));
    states.set(18_789, "absent");
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    await expect(ensureSandboxPortForward("box")).resolves.toBe(true);
    expect(mocks.startForward.mock.calls[0]?.[0].forward).toMatchObject({
      localHost: "0.0.0.0",
      port: 18_789,
    });
  });

  it("refuses remote exposure when onboarding did not prepare it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    await expect(ensureSandboxPortForward("box")).resolves.toBe(false);
    expect(mocks.observeForwards).not.toHaveBeenCalled();
    expect(mocks.startForward).not.toHaveBeenCalled();
  });

  it("fails closed when gateway authority cannot be resolved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.resolveGatewayForwardAuthority.mockImplementation(() => {
      throw new Error("authority unavailable");
    });
    const { ensureSandboxPortForward } = await import("./forward-recovery");

    await expect(ensureSandboxPortForward("box", { isWsl: false })).resolves.toBe(false);
    expect(mocks.startForward).not.toHaveBeenCalled();
  });
});

describe("declared and cleanup forward sets", () => {
  it("recovers the sandbox's own Hermes API port instead of a manifest default", async () => {
    mocks.getSandbox.mockReturnValue(
      sandboxEntry({
        agent: "hermes",
        dashboardPort: 18_790,
        hermesApiPort: 8_643,
      }),
    );
    states.set(8_643, "absent");
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");

    await expect(ensureDeclaredAgentForwardPortsHealthy("box", 18_790)).resolves.toBe(true);
    expect(mocks.startForward).toHaveBeenCalledOnce();
    expect(mocks.startForward.mock.calls[0]?.[0].forward.port).toBe(8_643);
  });

  it("reports the classified child exit when declared forward recovery fails", async () => {
    mocks.getSandbox.mockReturnValue(
      sandboxEntry({
        agent: "hermes",
        dashboardPort: 18_790,
        hermesApiPort: 8_643,
      }),
    );
    states.set(8_643, "absent");
    mocks.startForward.mockImplementationOnce(async (request: StartOpenShellForwardRequest) => ({
      state: "failed",
      forward: request.forward,
      effect: "none",
      error: {
        kind: "transport",
        message: "The OpenShell forward transport failed.",
      },
      failure: { stage: "startup", reason: "child_exited", exitStatus: 17 },
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");

    await expect(ensureDeclaredAgentForwardPortsHealthy("box", 18_790)).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      "  Warning: OpenShell ForwardTcp 8643 for box did not start: The OpenShell forward transport failed. [forward-start startup/child_exited status=17]",
    );
  });

  it("pins declared recovery to the selected gateway and workspace", async () => {
    mocks.getSandbox.mockReturnValue(
      sandboxEntry({
        agent: "hermes",
        dashboardPort: 18_790,
        gatewayName: "nemoclaw-19080",
        gatewayPort: 19_080,
        hermesApiPort: 8_643,
      }),
    );
    states.set(8_643, "absent");
    const { ensureDeclaredAgentForwardPortsHealthy } = await import("./forward-recovery");

    await expect(
      ensureDeclaredAgentForwardPortsHealthy("box", 18_790, {
        gatewayName: "nemoclaw-19080",
        workspace: "review-workspace",
      }),
    ).resolves.toBe(true);
    expect(mocks.startForward.mock.calls[0]?.[0].forward).toMatchObject({
      gatewayEndpoint: "https://127.0.0.1:19080",
      gatewayName: "nemoclaw-19080",
      workspace: "review-workspace",
      port: 8_643,
    });
  });

  it.each([
    ["released", true],
    ["bound", false],
  ] as const)("awaits remote dashboard release verification: %s", async (state, expected) => {
    mocks.getSandbox.mockReturnValue(sandboxEntry({ dashboardRemoteBindPrepared: true }));
    mocks.verifyForwardRelease.mockImplementationOnce(
      async (request: VerifyOpenShellForwardReleaseRequest) => ({
        state,
        forwards: request.forwards,
      }),
    );
    const { teardownSandboxDashboardForward } = await import("./forward-recovery");

    await expect(teardownSandboxDashboardForward("box")).resolves.toBe(expected);
    expect(mocks.verifyForwardRelease.mock.calls[0]?.[0].forwards[0]).toMatchObject({
      port: 18_789,
      localHost: "0.0.0.0",
    });
  });

  it.each([
    ["owned", true],
    ["foreign", false],
  ] as const)("awaits remote dashboard listener ownership: %s", async (state, expected) => {
    states.set(18_789, state);
    const { isSandboxPortForwardHealthy } = await import("./forward-recovery");

    await expect(isSandboxPortForwardHealthy("box", 18_789, "0.0.0.0")).resolves.toBe(expected);
    expect(mocks.observeForwards.mock.calls[0]?.[0].forwards[0]).toMatchObject({
      port: 18_789,
      localHost: "0.0.0.0",
    });
  });

  it("verifies release for the complete registered forward set", async () => {
    mocks.getSandbox.mockReturnValue(
      sandboxEntry({
        agent: "hermes",
        dashboardPort: 18_790,
        hermesApiPort: 8_643,
        hermesDashboardEnabled: true,
        hermesDashboardPort: 3_001,
        dashboardRemoteBindPrepared: true,
      }),
    );
    mocks.getRegisteredAgent.mockReturnValue(HERMES_AGENT);
    const { teardownSandboxDashboardForward } = await import("./forward-recovery");

    await expect(teardownSandboxDashboardForward("box")).resolves.toBe(true);
    expect(
      mocks.verifyForwardRelease.mock.calls[0]?.[0].forwards.map(
        (forward: OpenShellForwardIdentity) => forward.port,
      ),
    ).toEqual([18_790, 3_001, 8_643]);
    expect(mocks.verifyForwardRelease.mock.calls[0]?.[0].forwards[0]?.localHost).toBe("0.0.0.0");
  });
});
