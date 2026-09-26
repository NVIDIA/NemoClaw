// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../src/lib/agent/defs";
import type {
  ObserveOpenShellForwardsRequest,
  OpenShellForwardAdapter,
  OpenShellForwardIdentity,
  OpenShellForwardObservation,
  OpenShellForwardStartResult,
  RetireLegacyOpenShellForwardRequest,
  StartOpenShellForwardRequest,
} from "../../src/lib/adapters/openshell/forward";
import { createOnboardDashboardHelpers } from "../../src/lib/onboard/dashboard";
import type { ListSandboxesFn } from "../../src/lib/onboard/dashboard-port";

type ForwardObservationWithIdentity = Extract<
  OpenShellForwardObservation,
  { forward: OpenShellForwardIdentity }
>;
type ForwardState = ForwardObservationWithIdentity["state"];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function observation(
  forward: OpenShellForwardIdentity,
  state: ForwardState,
): ForwardObservationWithIdentity {
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

function harness(options: {
  listSandboxes: ListSandboxesFn;
  isWsl?: boolean;
  initialStates?: ReadonlyMap<number, ForwardState>;
  startFailurePort?: number;
  gatewayAuthority?: () => {
    readonly gatewayEndpoint: string;
    readonly localTlsDir?: string;
  };
}) {
  const states = new Map(options.initialStates);
  const observeForwards = vi.fn(async (request: ObserveOpenShellForwardsRequest) => {
    await request.assertCurrent?.();
    const observations = request.forwards.map((forward) =>
      observation(forward, states.get(forward.port) ?? "absent"),
    );
    await request.assertCurrent?.();
    return observations;
  });
  const startForward = vi.fn<OpenShellForwardAdapter["startForward"]>(
    async (request: StartOpenShellForwardRequest) => {
      await request.assertCurrent?.();
      switch (request.forward.port === options.startFailurePort) {
        case true:
          return {
            state: "failed" as const,
            forward: request.forward,
            effect: "none" as const,
            error: {
              kind: "transport" as const,
              message: "The OpenShell forward transport failed." as const,
            },
            failure: {
              stage: "startup" as const,
              reason: "child_exited" as const,
              exitStatus: 17,
            },
          };
      }
      const state = states.get(request.forward.port) ?? "absent";
      switch (state) {
        case "owned":
          return { state: "reused" as const, forward: request.forward };
        case "stale":
        case "foreign":
        case "indeterminate":
          return {
            state: "refused" as const,
            observation: observation(request.forward, state) as Extract<
              ForwardObservationWithIdentity,
              { state: "stale" | "foreign" | "indeterminate" }
            >,
          };
        case "absent":
          break;
      }
      states.set(request.forward.port, "owned");
      await request.assertCurrent?.();
      return {
        state: "started" as const,
        forward: request.forward,
        cleanup: vi.fn(async () => {
          states.set(request.forward.port, "absent");
          return { state: "released" as const };
        }),
      };
    },
  );
  const retireLegacyForward = vi.fn(async (request: RetireLegacyOpenShellForwardRequest) => {
    await request.assertCurrent?.();
    await request.authorize(request.forward);
    states.set(request.forward.port, "absent");
    await request.assertCurrent?.();
    return { state: "retired" as const, forward: request.forward };
  });
  const adapter = {
    observeForwards,
    startForward,
    retireLegacyForward,
    verifyForwardRelease: vi.fn(async () => ({ state: "released" as const })),
  };
  const helpers = createOnboardDashboardHelpers({
    runCaptureOpenshell: vi.fn(() => ""),
    cliName: () => "nemoclaw",
    agentProductName: () => "NemoClaw",
    getProviderLabel: (provider) => provider,
    note: vi.fn(),
    isWsl: () => options.isWsl ?? false,
    redact: String,
    sleep: vi.fn(),
    printAgentDashboardUi: vi.fn(),
    listSandboxes: options.listSandboxes,
    getSandbox: (name) => options.listSandboxes().sandboxes.find((entry) => entry.name === name),
    getGatewayForwardRuntimeAuthority:
      options.gatewayAuthority ?? (() => ({ gatewayEndpoint: "https://127.0.0.1:8080" })),
    resolveForwardGatewayName: (sandbox) => sandbox?.gatewayName ?? "nemoclaw",
    forwardAdapterForAuthority: vi.fn(() => adapter),
  });
  return { helpers, observeForwards, retireLegacyForward, startForward, states };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("finalization dashboard ForwardTcp reconciliation", () => {
  it("proves exact ownership for pre-delete port reservation", async () => {
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790, hermesApiPort: 8_643 }],
      }),
      initialStates: new Map([[8_643, "owned"]]),
    });

    await expect(
      test.helpers.createForwardPortObserver("reonboard-test")([8_643, 8_644]),
    ).resolves.toMatchObject([{ state: "owned" }, { state: "absent" }]);
    expect(test.observeForwards.mock.calls[0]?.[0].forwards[0]).toMatchObject({
      gatewayEndpoint: "https://127.0.0.1:8080",
      gatewayName: "nemoclaw",
      workspace: "default",
      sandboxName: "reonboard-test",
      localHost: "127.0.0.1",
      port: 8_643,
    });
  });

  it.each([
    { name: "WSL", isWsl: true, dashboardBind: undefined, persistedRemoteBind: false },
    {
      name: "remote dashboard bind",
      isWsl: false,
      dashboardBind: "0.0.0.0",
      persistedRemoteBind: false,
    },
    {
      name: "persisted remote dashboard bind",
      isWsl: false,
      dashboardBind: undefined,
      persistedRemoteBind: true,
    },
  ])(
    "keeps auxiliary ownership loopback-only during $name resume",
    async ({ isWsl, dashboardBind, persistedRemoteBind }) => {
      vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", dashboardBind);
      const test = harness({
        isWsl,
        listSandboxes: () => ({
          sandboxes: [
            {
              name: "reonboard-test",
              dashboardRemoteBindPrepared: persistedRemoteBind,
            },
          ],
        }),
        initialStates: new Map([[8_643, "owned"]]),
      });

      await test.helpers.createForwardPortObserver("reonboard-test", "loopback")([8_643]);
      expect(test.observeForwards.mock.calls[0]?.[0].forwards[0]?.localHost).toBe("127.0.0.1");
      await test.helpers.createForwardPortObserver("reonboard-test")([8_643]);
      expect(test.observeForwards.mock.calls[1]?.[0].forwards[0]?.localHost).toBe("0.0.0.0");
    },
  );

  it("launches the persisted dashboard port and publishes its URL", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
    });

    await expect(test.helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      18_790,
    );
    expect(test.startForward).toHaveBeenCalledOnce();
    expect(test.startForward.mock.calls[0]?.[0].forward).toMatchObject({
      sandboxName: "reonboard-test",
      port: 18_790,
    });
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it.each(["foreign", "indeterminate"] as const)(
    "leaves a %s persisted listener untouched with zero mutation attempts",
    async (state) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      const test = harness({
        listSandboxes: () => ({
          sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
        }),
        initialStates: new Map([[18_790, state]]),
      });

      await expect(
        test.helpers.ensureFinalizationDashboardForward("reonboard-test"),
      ).rejects.toThrow(/cannot be reallocated|could not prove/u);
      expect(test.startForward).not.toHaveBeenCalled();
      expect(test.retireLegacyForward).not.toHaveBeenCalled();
    },
  );

  it("retires an exact stale forward before one replacement start", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      initialStates: new Map([[18_790, "stale"]]),
    });

    await expect(test.helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      18_790,
    );
    expect(test.retireLegacyForward).toHaveBeenCalledOnce();
    expect(test.startForward).toHaveBeenCalledTimes(2);
  });

  it("reuses an exactly owned dashboard forward", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      initialStates: new Map([[18_790, "owned"]]),
    });

    await expect(test.helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      18_790,
    );
    expect(test.startForward).toHaveBeenCalledOnce();
    await expect(test.startForward.mock.results[0]?.value).resolves.toMatchObject({
      state: "reused",
    });
  });

  it("does not reuse a port registered by another sandbox", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18_790 },
          { name: "other", dashboardPort: 18_790 },
        ],
      }),
    });

    await expect(test.helpers.ensureFinalizationDashboardForward("reonboard-test")).rejects.toThrow(
      /another sandbox registered it/u,
    );
    expect(test.startForward).not.toHaveBeenCalled();
  });

  it.each(["openclaw", "hermes"])(
    "reuses registered forwards for %s without creating another listener",
    async (name) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      const ports = name === "openclaw" ? [18_790] : [18_790, 8_643];
      const test = harness({
        listSandboxes: () => ({
          sandboxes: [
            { name: "reonboard-test", dashboardPort: 18_790, hermesApiPort: 8_643 },
            { name: "sibling", dashboardPort: 18_789, hermesApiPort: 8_642 },
          ],
        }),
        initialStates: new Map(ports.map((port) => [port, "owned" as const])),
      });

      await expect(
        test.helpers.ensureFinalizationAgentDashboardForward("reonboard-test", loadAgent(name)),
      ).resolves.toBe(18_790);
      expect(test.startForward.mock.calls.map(([request]) => request.forward.port)).toEqual(ports);
    },
  );

  it("awaits every forward start and propagates a rejected start", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790, hermesApiPort: 8_643 }],
      }),
    });
    const first = deferred<OpenShellForwardStartResult>();
    const second = deferred<OpenShellForwardStartResult>();
    test.startForward
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    let settled = false;
    const finalization = test.helpers
      .ensureFinalizationAgentDashboardForward("reonboard-test", loadAgent("hermes"))
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.waitFor(() => expect(test.startForward).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    const firstForward = test.startForward.mock.calls[0]?.[0].forward;
    expect(firstForward).toBeDefined();
    first.resolve({ state: "reused", forward: firstForward! });
    await vi.waitFor(() => expect(test.startForward).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    const secondForward = test.startForward.mock.calls[1]?.[0].forward;
    expect(secondForward).toBeDefined();
    second.resolve({ state: "reused", forward: secondForward! });
    await expect(finalization).resolves.toBe(18_790);

    const failure = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790, hermesApiPort: 8_643 }],
      }),
    });
    failure.startForward.mockRejectedValueOnce(new Error("forward startup rejected"));
    await expect(
      failure.helpers.ensureFinalizationAgentDashboardForward(
        "reonboard-test",
        loadAgent("hermes"),
      ),
    ).rejects.toThrow(/forward startup rejected/u);
  });

  it.each([18_790, 8_643])(
    "establishes missing Hermes forward %s on its recorded port",
    async (missingPort) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      const otherPort = missingPort === 18_790 ? 8_643 : 18_790;
      const test = harness({
        listSandboxes: () => ({
          sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790, hermesApiPort: 8_643 }],
        }),
        initialStates: new Map([[otherPort, "owned"]]),
      });

      await expect(
        test.helpers.ensureFinalizationAgentDashboardForward("reonboard-test", loadAgent("hermes")),
      ).resolves.toBe(18_790);
      expect(
        test.startForward.mock.calls.filter(([request]) => request.forward.port === missingPort),
      ).toHaveLength(1);
    },
  );

  it("reports a safe classification when the agent forward child fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const test = harness({
      listSandboxes: () => ({ sandboxes: [{ name: "reonboard-test" }] }),
      startFailurePort: 8_642,
    });

    await expect(
      test.helpers.ensureAgentFixedForward("reonboard-test", 8_642, "Hermes API"),
    ).resolves.toBe(false);
    expect(test.startForward).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "! Hermes API forward on port 8642 did not start: The OpenShell forward transport failed. [forward-start startup/child_exited status=17]",
    );
  });

  it("honors an explicit dashboard URL", async () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:19001");
    const test = harness({ listSandboxes: () => ({ sandboxes: [] }) });

    await expect(test.helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      19_001,
    );
    expect(test.startForward.mock.calls[0]?.[0].forward.port).toBe(19_001);
  });
});
