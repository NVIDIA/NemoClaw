// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCliOpenShellForwardAdapter } from "../../adapters/openshell/forward-cli";
import {
  captured,
  capturedForwardList,
  createHarness,
  createLinuxProcFixture,
  missingCommand,
  noActiveForwards,
  runtimeSelection,
  type SpawnForward,
} from "../../adapters/openshell/forward-cli-test-fixture";
import { createHermesApiForwardMigration } from "../../agent/hermes-api-forward";

import type {
  ObserveOpenShellForwardsRequest,
  OpenShellForwardIdentity,
  OpenShellForwardObservation,
  OpenShellForwardReleaseResult,
  OpenShellLegacyForwardRetirementResult,
  RetireLegacyOpenShellForwardRequest,
  StartOpenShellForwardRequest,
  VerifyOpenShellForwardReleaseRequest,
} from "../../adapters/openshell/forward";
import { OPENSHELL_HEAVY_TIMEOUT_MS } from "../../adapters/openshell/timeouts";

import type { HermesDashboardRecoveryConfig } from "./hermes-dashboard-recovery";

const mocks = vi.hoisted(() => ({
  createAdapter: vi.fn(),
  getHermesDashboardRecoveryConfig: vi.fn<(name: string) => HermesDashboardRecoveryConfig | null>(
    () => null,
  ),
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
  getSandboxAcrossGatewayRoots: mocks.getSandbox,
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
    mocks.getSandbox.mockReturnValue(sandboxEntry({ agent: "hermes", hermesApiPort: 8_643 }));
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
    expect(input.deps.readSandbox?.()).toMatchObject({ agent: "hermes", hermesApiPort: 8_643 });
    mocks.getSandbox.mockReturnValue(sandboxEntry({ agent: "hermes", hermesApiPort: 8_644 }));
    expect(input.deps.readSandbox?.()).toMatchObject({ hermesApiPort: 8_644 });
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

  it.each([8_642, 8_643])(
    "migrates an owned wildcard Hermes API on port %i during recovery",
    async (port) => {
      mocks.getSandbox.mockReturnValue(sandboxEntry({ agent: "hermes", hermesApiPort: port }));
      let migrated = false;
      mocks.observeForwards.mockImplementation(async (request: ObserveOpenShellForwardsRequest) => {
        await request.assertCurrent?.();
        return request.forwards.map((forward) =>
          observation(
            forward,
            forward.port !== port || migrated || forward.localHost === "0.0.0.0"
              ? "owned"
              : "foreign",
          ),
        );
      });
      mocks.retireLegacyForward.mockImplementation(
        async (request: RetireLegacyOpenShellForwardRequest) => {
          await request.assertCurrent?.();
          await request.authorize(request.forward);
          migrated = true;
          return { state: "retired", forward: request.forward };
        },
      );
      const { ensureSandboxPortForwardForPort, areSandboxLaunchForwardsHealthy } =
        await import("./forward-recovery");

      await expect(ensureSandboxPortForwardForPort("box", port)).resolves.toBe(true);
      expect(mocks.retireLegacyForward).toHaveBeenCalledWith(
        expect.objectContaining({
          forward: expect.objectContaining({ sandboxName: "box", port, localHost: "0.0.0.0" }),
          migrateToLoopback: true,
        }),
      );
      expect(mocks.startForward).toHaveBeenCalledWith(
        expect.objectContaining({
          forward: expect.objectContaining({ port, localHost: "127.0.0.1" }),
        }),
      );
      await expect(areSandboxLaunchForwardsHealthy("box")).resolves.toBe(true);
    },
  );

  it.each(["foreign", "indeterminate"] as const)(
    "preserves a %s wildcard Hermes API listener",
    async (state) => {
      mocks.getSandbox.mockReturnValue(sandboxEntry({ agent: "hermes", hermesApiPort: 8_642 }));
      mocks.observeForwards.mockImplementation(async (request: ObserveOpenShellForwardsRequest) =>
        request.forwards.map((forward) =>
          observation(forward, forward.localHost === "0.0.0.0" ? state : "foreign"),
        ),
      );
      const { ensureSandboxPortForwardForPort } = await import("./forward-recovery");
      await expect(ensureSandboxPortForwardForPort("box", 8_642)).resolves.toBe(false);
      expect(mocks.retireLegacyForward).not.toHaveBeenCalled();
      expect(mocks.startForward).not.toHaveBeenCalled();
    },
  );

  it("does not replace a wildcard API when retirement cannot prove release", async () => {
    mocks.getSandbox.mockReturnValue(sandboxEntry({ agent: "hermes", hermesApiPort: 8_642 }));
    mocks.observeForwards.mockImplementation(async (request: ObserveOpenShellForwardsRequest) =>
      request.forwards.map((forward) =>
        observation(forward, forward.localHost === "0.0.0.0" ? "owned" : "foreign"),
      ),
    );
    mocks.retireLegacyForward.mockImplementation(
      async (
        request: RetireLegacyOpenShellForwardRequest,
      ): Promise<OpenShellLegacyForwardRetirementResult> => ({
        state: "release_unproved",
        forward: request.forward,
        effect: "possible",
        error: { kind: "cleanup", message: "NemoClaw could not prove OpenShell forward cleanup." },
      }),
    );
    const { ensureSandboxPortForwardForPort } = await import("./forward-recovery");
    await expect(ensureSandboxPortForwardForPort("box", 8_642)).resolves.toBe(false);
    expect(mocks.retireLegacyForward).toHaveBeenCalledOnce();
    expect(mocks.startForward).not.toHaveBeenCalled();
  });

  it.each(["agent", "port", "gateway"])(
    "refuses wildcard migration when %s authority changes",
    async (field) => {
      mocks.getSandbox.mockReturnValue(sandboxEntry({ agent: "hermes", hermesApiPort: 8_642 }));
      mocks.observeForwards.mockImplementation(async (request: ObserveOpenShellForwardsRequest) => {
        await request.assertCurrent?.();
        return request.forwards.map((forward) =>
          observation(forward, forward.localHost === "0.0.0.0" ? "owned" : "foreign"),
        );
      });
      mocks.retireLegacyForward.mockImplementation(
        async (request: RetireLegacyOpenShellForwardRequest) => {
          mocks.getSandbox.mockReturnValue(
            sandboxEntry({
              agent: field === "agent" ? "openclaw" : "hermes",
              hermesApiPort: field === "port" ? 8_643 : 8_642,
              gatewayName: field === "gateway" ? "nemoclaw-19080" : "nemoclaw",
              gatewayPort: field === "gateway" ? 19_080 : 8_080,
            }),
          );
          await request.authorize(request.forward);
          return { state: "retired", forward: request.forward };
        },
      );
      const { ensureSandboxPortForwardForPort } = await import("./forward-recovery");
      await expect(ensureSandboxPortForwardForPort("box", 8_642)).resolves.toBe(false);
      expect(mocks.retireLegacyForward).toHaveBeenCalledOnce();
      expect(mocks.startForward).not.toHaveBeenCalled();
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

  it.each(["owned", "absent"] as const)(
    "recovers the prepared Hermes dashboard from %s using its remote bind",
    async (state) => {
      states.set(18_789, state);
      mocks.getSandbox.mockReturnValue(
        sandboxEntry({ agent: "hermes", dashboardRemoteBindPrepared: true }),
      );
      mocks.getHermesDashboardRecoveryConfig.mockReturnValue({
        publicPort: 18_789,
        internalPort: 28_789,
      });
      const { ensureHermesDashboardPortForwardIfEnabled } = await import("./forward-recovery");
      await expect(ensureHermesDashboardPortForwardIfEnabled("box")).resolves.toBe(true);
      expect(mocks.observeForwards.mock.calls[0]?.[0].forwards[0]).toMatchObject({
        localHost: "0.0.0.0",
        port: 18_789,
      });
      expect(mocks.startForward).toHaveBeenCalledTimes(state === "owned" ? 0 : 1);
    },
  );

  it.each(["openclaw", "hermes"])("refuses unprepared remote exposure for %s", async (agent) => {
    mocks.getSandbox.mockReturnValue(sandboxEntry({ agent }));
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

  it.each(["bound", "timeout", "authority", "validation"] as const)(
    "reports forward release %s without including the error message",
    async (outcome) => {
      mocks.getRegisteredAgent.mockReturnValue(null);
      const errors = {
        timeout: { kind: "timeout", message: "The OpenShell forward operation timed out." },
        authority: {
          kind: "authority",
          message: "NemoClaw could not prove current OpenShell forward authority.",
        },
        validation: { kind: "validation", message: "The OpenShell forward request is invalid." },
      } as const;
      mocks.verifyForwardRelease.mockImplementationOnce(
        async (
          request: VerifyOpenShellForwardReleaseRequest,
        ): Promise<OpenShellForwardReleaseResult> =>
          outcome === "bound"
            ? { state: "bound", forwards: request.forwards }
            : {
                state: "indeterminate",
                ...(outcome === "validation" ? {} : { forwards: request.forwards }),
                error: errors[outcome],
              },
      );
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { teardownSandboxDashboardForward } = await import("./forward-recovery");

      await expect(teardownSandboxDashboardForward("box")).resolves.toBe(false);
      const classification = outcome === "bound" ? "bound" : `indeterminate/${outcome}`;
      expect(consoleError).toHaveBeenCalledExactlyOnceWith(
        "  ForwardTcp port release was not verified for registered host port(s): 18789. " +
          `[forward-release ${classification}]`,
      );
      expect(mocks.verifyForwardRelease).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ timeoutMs: 5_000, assertCurrent: expect.any(Function) }),
      );
      expect(mocks.startForward).not.toHaveBeenCalled();
      expect(mocks.retireLegacyForward).not.toHaveBeenCalled();
    },
  );
});

it.each([
  {
    gateway: "nemoclaw",
    endpoint: "https://127.0.0.1:8080",
    state: "started",
    signals: [[4_312, "SIGKILL"]],
    starts: 1,
    local: "127.0.0.1:8642",
  },
  {
    gateway: "nemoclaw",
    endpoint: null,
    state: null,
    signals: [],
    starts: 0,
    local: "0.0.0.0:8642",
  },
  {
    gateway: "nemoclaw",
    endpoint: "https://127.0.0.1:19080",
    state: null,
    signals: [],
    starts: 0,
    local: "0.0.0.0:8642",
  },
  {
    gateway: "other",
    endpoint: "https://127.0.0.1:8080",
    state: null,
    signals: [],
    starts: 0,
    local: "0.0.0.0:8642",
  },
] as const)(
  "checks Hermes API command authority for gateway $gateway and endpoint $endpoint through the CLI adapter",
  async ({ gateway, endpoint, state, signals, starts, local }) => {
    const fixture = createLinuxProcFixture({ pid: 4_312 });
    const tcpPath = path.join(fixture.procRoot, "net", "tcp");
    const originalTcp = readFileSync(tcpPath, "utf8");
    const wildcardTcp = originalTcp.replace("0100007F:4965", "00000000:21C2");
    const forward = {
      gatewayEndpoint: "https://127.0.0.1:8080",
      gatewayName: "nemoclaw",
      workspace: "default",
      sandboxName: "demo",
      localHost: "127.0.0.1" as const,
      port: 8_642,
    };
    let command = [
      fixture.executable,
      `--gateway ${gateway}${endpoint === null ? "" : ` --gateway-endpoint ${endpoint}`} --workspace default`,
      "forward service demo --target-port 8642 --target-host 127.0.0.1 --local 0.0.0.0:8642",
    ].join(" ");
    let started = false;
    const { child } = createHarness();
    const signalProcess = vi.fn(() => {
      writeFileSync(tcpPath, originalTcp.split("\n")[0] + "\n");
      rmSync(path.join(fixture.procRoot, "4312"), { recursive: true, force: true });
    });
    const spawn = vi.fn<SpawnForward>((_executable, args) => {
      started = true;
      command = [fixture.executable, ...args].join(" ");
      fixture.addSocketOwner(child.pid!);
      writeFileSync(tcpPath, wildcardTcp.replace("00000000:21C2", "0100007F:21C2"));
      return child;
    });
    const adapter = createCliOpenShellForwardAdapter({
      environment: {},
      executable: fixture.executable,
      gatewayEndpoint: forward.gatewayEndpoint,
      hostProbe: async (executable) =>
        executable === "/usr/bin/lsof" ? missingCommand() : captured(0, `${command}\n`),
      platform: "linux",
      probePort: async () => ({ state: started ? ("bound" as const) : ("unbound" as const) }),
      procRoot: fixture.procRoot,
      run: async () => capturedForwardList(noActiveForwards),
      runtimeSelection,
      signalProcess,
      spawn,
    });
    writeFileSync(tcpPath, wildcardTcp);
    try {
      const wildcard = { ...forward, localHost: "0.0.0.0" as const };
      await expect(adapter.observeForwards({ forwards: [wildcard] })).resolves.toEqual([
        { state: state === "started" ? "owned" : "foreign", forward: wildcard },
      ]);
      const migration = createHermesApiForwardMigration({
        forward,
        readSandbox: () => ({ agent: "hermes", hermesApiPort: 8_642 }),
        adapter,
        assertCurrent: vi.fn(),
      });
      const result = await migration.migrate();
      expect(result?.state ?? null).toBe(state);
      expect(signalProcess.mock.calls).toEqual(signals);
      expect(spawn).toHaveBeenCalledTimes(starts);
      expect(command).toContain(`--local ${local}`);
    } finally {
      fixture.remove();
    }
  },
);
