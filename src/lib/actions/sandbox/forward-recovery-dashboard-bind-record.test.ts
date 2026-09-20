// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ObserveOpenShellForwardsRequest,
  OpenShellForwardIdentity,
  OpenShellForwardObservation,
  StartOpenShellForwardRequest,
} from "../../adapters/openshell/forward";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn((_args: string[], _options?: unknown) => ({ status: 0 })),
  getSandbox: vi.fn(),
  updateSandbox: vi.fn(() => true),
  createAdapter: vi.fn(),
  observeForwards: vi.fn(),
  startForward: vi.fn(),
  retireLegacyForward: vi.fn(),
  verifyForwardRelease: vi.fn(),
  resolveGatewayForwardAuthority: vi.fn(),
  resolveGatewayForwardRuntimeAuthority: vi.fn(),
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
vi.mock("../../agent/runtime", () => ({
  getSessionAgent: () => ({ forward_ports: [18789], forwardPort: 18789 }),
  hasGatewayRuntime: () => true,
}));
vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
  updateSandbox: mocks.updateSandbox,
}));
vi.mock("./hermes-dashboard-recovery", () => ({
  getHermesDashboardRecoveryConfig: () => null,
  ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
}));

import { ensureSandboxPortForward, ensureSandboxPortForwardForPort } from "./forward-recovery";

const SANDBOX = { name: "hm", agent: "hermes", dashboardPort: 18789 };
let listenerState: OpenShellForwardObservation["state"] = "absent";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  listenerState = "absent";
  mocks.updateSandbox.mockReturnValue(true);
  mocks.getSandbox.mockReturnValue(SANDBOX);
  mocks.resolveGatewayForwardAuthority.mockReturnValue({
    endpoint: "https://127.0.0.1:8080",
    gatewayName: "nemoclaw-8080",
    gatewayPort: 8080,
    localTlsDir: null,
  });
  mocks.resolveGatewayForwardRuntimeAuthority.mockReturnValue({
    gatewayEndpoint: "https://127.0.0.1:8080",
    gatewayName: "nemoclaw-8080",
    workspace: "default",
  });
  mocks.observeForwards.mockImplementation(async (request: ObserveOpenShellForwardsRequest) => {
    await request.assertCurrent?.();
    return request.forwards.map((forward) => observation(forward, listenerState));
  });
  mocks.startForward.mockImplementation(async (request: StartOpenShellForwardRequest) => {
    await request.assertCurrent?.();
    listenerState = "owned";
    return {
      state: "started",
      forward: request.forward,
      cleanup: vi.fn(async () => ({ state: "released" as const })),
    };
  });
  mocks.retireLegacyForward.mockImplementation(async () => {
    throw new Error("legacy retirement should not run");
  });
  mocks.createAdapter.mockReturnValue({
    observeForwards: mocks.observeForwards,
    startForward: mocks.startForward,
    retireLegacyForward: mocks.retireLegacyForward,
    verifyForwardRelease: mocks.verifyForwardRelease,
  });
});

describe("the recorded dashboard bind follows the forward (#10861)", () => {
  it("records the loopback bind when recovery re-creates the forward without an opt-in", async () => {
    await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(true);

    expect(mocks.startForward).toHaveBeenCalledOnce();
    expect(mocks.startForward).toHaveBeenCalledWith({
      forward: expect.objectContaining({ localHost: "127.0.0.1", port: 18789 }),
      assertCurrent: expect.any(Function),
    });
    expect(mocks.updateSandbox).toHaveBeenCalledWith("hm", { dashboardBindAddress: "127.0.0.1" });
  });

  it("records the wide bind before starting the forward when the operator opted in and the sandbox was prepared for it", async () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    mocks.getSandbox.mockReturnValue({ ...SANDBOX, dashboardRemoteBindPrepared: true });

    await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(true);

    expect(mocks.startForward).toHaveBeenCalledWith({
      forward: expect.objectContaining({ localHost: "0.0.0.0", port: 18789 }),
      assertCurrent: expect.any(Function),
    });
    expect(mocks.updateSandbox).toHaveBeenCalledWith("hm", { dashboardBindAddress: "0.0.0.0" });
    expect(mocks.updateSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startForward.mock.invocationCallOrder[0],
    );
  });

  it("records the wide bind WSL requires without an opt-in", async () => {
    await expect(ensureSandboxPortForward("hm", { isWsl: true })).resolves.toBe(true);

    expect(mocks.startForward).toHaveBeenCalledWith({
      forward: expect.objectContaining({ localHost: "0.0.0.0", port: 18789 }),
      assertCurrent: expect.any(Function),
    });
    expect(mocks.updateSandbox).toHaveBeenCalledWith("hm", { dashboardBindAddress: "0.0.0.0" });
  });

  it("leaves the record alone when the forward is already reachable", async () => {
    listenerState = "owned";

    await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(true);

    expect(mocks.startForward).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not record a bind for a forward that is not the dashboard's", async () => {
    await expect(
      ensureSandboxPortForwardForPort("hm", 8642, { expectedBind: "127.0.0.1" }),
    ).resolves.toBe(true);

    expect(mocks.startForward).toHaveBeenCalledOnce();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("still starts a loopback forward and warns when the record cannot be written", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.updateSandbox.mockReturnValue(false);

    await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(true);

    expect(mocks.startForward).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("could not be recorded"));
  });

  it("still starts a loopback forward and warns when recording the bind throws", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.updateSandbox.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(true);

    expect(mocks.startForward).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("recording it for 'hm' failed"));
  });

  it("still starts a loopback forward when the write fails but the record already says loopback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getSandbox.mockReturnValue({ ...SANDBOX, dashboardBindAddress: "127.0.0.1" });
    mocks.updateSandbox.mockReturnValue(false);

    await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(true);

    expect(mocks.startForward).toHaveBeenCalledOnce();
  });

  const rejectedWrite = () => false;
  const throwingWrite = () => {
    throw new Error("disk full");
  };

  it.each([
    ["the opt-in", "the write is rejected", true, false, rejectedWrite],
    ["the opt-in", "the write throws", true, false, throwingWrite],
    ["WSL", "the write is rejected", false, true, rejectedWrite],
    ["WSL", "the write throws", false, true, throwingWrite],
  ])(
    "refuses to start the wide forward %s requires when %s",
    async (_trigger, _case, optIn, isWsl, write) => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", optIn ? "0.0.0.0" : "");
      mocks.getSandbox.mockReturnValue({ ...SANDBOX, dashboardRemoteBindPrepared: true });
      mocks.updateSandbox.mockImplementation(write);

      await expect(ensureSandboxPortForward("hm", { isWsl })).resolves.toBe(false);

      expect(mocks.startForward).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          "Refusing to start the dashboard forward for 'hm' on all interfaces",
        ),
      );
    },
  );

  it.each([
    ["the write is rejected", rejectedWrite],
    ["the write throws", throwingWrite],
  ])(
    "refuses a loopback forward while the registry still records a wide bind and %s",
    async (_case, write) => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.getSandbox.mockReturnValue({ ...SANDBOX, dashboardBindAddress: "0.0.0.0" });
      mocks.updateSandbox.mockImplementation(write);

      await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(false);

      expect(mocks.startForward).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("on loopback: the registry still records a bind on 0.0.0.0"),
      );
    },
  );

  it.each([
    ["a loopback record", "127.0.0.1"],
    ["no record", null],
  ])(
    "puts back %s when the wide forward fails to start after its bind was recorded",
    async (_label, previous) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
      mocks.getSandbox.mockReturnValue({
        ...SANDBOX,
        dashboardRemoteBindPrepared: true,
        dashboardBindAddress: previous,
      });
      mocks.startForward.mockImplementation(async () => {
        throw new Error("forward service exited");
      });

      await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(false);

      expect(mocks.updateSandbox).toHaveBeenNthCalledWith(1, "hm", {
        dashboardBindAddress: "0.0.0.0",
      });
      expect(mocks.updateSandbox).toHaveBeenLastCalledWith("hm", {
        dashboardBindAddress: previous,
      });
    },
  );

  it("warns when the previous record cannot be put back after the wide forward fails to start", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    mocks.getSandbox.mockReturnValue({
      ...SANDBOX,
      dashboardRemoteBindPrepared: true,
      dashboardBindAddress: "127.0.0.1",
    });
    mocks.updateSandbox.mockReturnValueOnce(true).mockReturnValue(false);
    mocks.startForward.mockImplementation(async () => {
      throw new Error("forward service exited");
    });

    await expect(ensureSandboxPortForward("hm", { isWsl: false })).resolves.toBe(false);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("could not be restored"));
  });
});
