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
  initialHosts?: ReadonlyMap<number, OpenShellForwardIdentity["localHost"]>;
  startFailurePort?: number;
  gatewayAuthority?: () => {
    readonly gatewayEndpoint: string;
    readonly localTlsDir?: string;
  };
}) {
  const states = new Map(options.initialStates);
  const hosts = new Map(options.initialHosts);
  const stateFor = (forward: OpenShellForwardIdentity): ForwardState => {
    const state = states.get(forward.port) ?? "absent";
    const host = hosts.get(forward.port);
    return state === "owned" && host !== undefined && host !== forward.localHost
      ? "foreign"
      : state;
  };
  const observeForwards = vi.fn(async (request: ObserveOpenShellForwardsRequest) => {
    await request.assertCurrent?.();
    const observations = request.forwards.map((forward) => observation(forward, stateFor(forward)));
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
      const state = stateFor(request.forward);
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
      hosts.set(request.forward.port, request.forward.localHost);
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
  const retireLegacyForward = vi.fn<OpenShellForwardAdapter["retireLegacyForward"]>(
    async (request: RetireLegacyOpenShellForwardRequest) => {
      await request.assertCurrent?.();
      await request.authorize(request.forward);
      states.set(request.forward.port, "absent");
      hosts.delete(request.forward.port);
      await request.assertCurrent?.();
      return { state: "retired" as const, forward: request.forward };
    },
  );
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
  return { helpers, observeForwards, retireLegacyForward, startForward, states, hosts };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("finalization dashboard ForwardTcp reconciliation", () => {
  it.each(
    [
      { exposure: "WSL", isWsl: true, dashboardBind: undefined, persistedRemoteBind: false },
      {
        exposure: "explicit remote bind",
        isWsl: false,
        dashboardBind: "0.0.0.0",
        persistedRemoteBind: false,
      },
      {
        exposure: "persisted remote bind",
        isWsl: false,
        dashboardBind: undefined,
        persistedRemoteBind: true,
      },
    ].flatMap((exposure) =>
      [false, true].flatMap((resume) =>
        [8_642, 8_643].map((apiPort) => ({ ...exposure, resume, apiPort })),
      ),
    ),
  )(
    "keeps Hermes API $apiPort on loopback with $exposure and resume=$resume (#13441)",
    async ({ isWsl, dashboardBind, persistedRemoteBind, resume, apiPort }) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", dashboardBind);
      const test = harness({
        isWsl,
        listSandboxes: () => ({
          sandboxes: [
            {
              name: "hermes-test",
              agent: "hermes",
              dashboardPort: 18_790,
              hermesApiPort: apiPort,
              dashboardRemoteBindPrepared: persistedRemoteBind,
            },
          ],
        }),
        initialStates: resume
          ? new Map([
              [18_790, "owned"],
              [apiPort, "owned"],
            ])
          : undefined,
      });

      await expect(
        test.helpers.ensureFinalizationAgentDashboardForward("hermes-test", loadAgent("hermes")),
      ).resolves.toBe(18_790);
      const started = test.startForward.mock.calls.map(([request]) => request.forward);
      expect(started).toMatchObject([
        { sandboxName: "hermes-test", localHost: "0.0.0.0", port: 18_790 },
        { sandboxName: "hermes-test", localHost: "127.0.0.1", port: apiPort },
      ]);
      await expect(
        test.helpers.createForwardPortObserver("hermes-test", "loopback")([apiPort]),
      ).resolves.toMatchObject([{ state: "owned", forward: started[1] }]);
      expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
      expect(test.retireLegacyForward).not.toHaveBeenCalled();
    },
  );

  it.each([8_642, 8_643])(
    "migrates an owned wildcard Hermes API on port %s to loopback (#13441)",
    async (apiPort) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
      const test = harness({
        listSandboxes: () => ({
          sandboxes: [
            {
              name: "hermes-test",
              agent: "hermes",
              dashboardPort: 18_790,
              hermesApiPort: apiPort,
              dashboardRemoteBindPrepared: true,
            },
          ],
        }),
        initialStates: new Map([
          [18_790, "owned"],
          [apiPort, "owned"],
        ]),
        initialHosts: new Map([
          [18_790, "0.0.0.0"],
          [apiPort, "0.0.0.0"],
        ]),
      });
      await expect(
        test.helpers.ensureFinalizationAgentDashboardForward("hermes-test", loadAgent("hermes")),
      ).resolves.toBe(18_790);
      expect(test.retireLegacyForward).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          forward: expect.objectContaining({
            sandboxName: "hermes-test",
            localHost: "0.0.0.0",
            port: apiPort,
          }),
          migrateToLoopback: true,
        }),
      );
      expect(test.hosts.get(apiPort)).toBe("127.0.0.1");
      expect(test.hosts.get(18_790)).toBe("0.0.0.0");
    },
  );

  it.each([
    { agent: "openclaw", hermesApiPort: 8_643 },
    { agent: undefined, hermesApiPort: 8_643 },
    { agent: "hermes", hermesApiPort: 8_644 },
  ])("refuses wildcard finalization outside the registered Hermes API: %j", async (entry) => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "hermes-test", dashboardPort: 18_790, ...entry }],
      }),
      initialStates: new Map([[8_643, "owned"]]),
      initialHosts: new Map([[8_643, "0.0.0.0"]]),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      test.helpers.ensureAgentFixedForward("hermes-test", 8_643, "messaging"),
    ).resolves.toBe(false);
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(test.hosts.get(8_643)).toBe("0.0.0.0");
  });

  it("leaves an owned wildcard non-Hermes fixed forward untouched during finalization", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "openclaw-test", agent: "openclaw", dashboardPort: 18_789 }],
      }),
      initialStates: new Map([[8_643, "owned"]]),
      initialHosts: new Map([[8_643, "0.0.0.0"]]),
    });
    const agent = { ...loadAgent("openclaw")!, forward_ports: [18_789, 8_643] };
    await expect(
      test.helpers.ensureFinalizationAgentDashboardForward("openclaw-test", agent),
    ).rejects.toThrow("foreign listener");
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(test.hosts.get(8_643)).toBe("0.0.0.0");
  });

  it.each([
    { field: "agent", update: { agent: "openclaw" } },
    { field: "port", update: { hermesApiPort: 8_644 } },
  ])("refuses API migration after registered $field changes", async ({ update }) => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const entry = { name: "hermes-test", agent: "hermes", hermesApiPort: 8_643 };
    const test = harness({
      listSandboxes: () => ({ sandboxes: [entry] }),
      initialStates: new Map([[8_643, "owned"]]),
      initialHosts: new Map([[8_643, "0.0.0.0"]]),
    });
    test.observeForwards.mockImplementationOnce(async (request) => {
      Object.assign(entry, update);
      return request.forwards.map((forward) => observation(forward, "owned"));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      test.helpers.ensureAgentFixedForward("hermes-test", 8_643, "agent API"),
    ).resolves.toBe(false);
    expect(test.hosts.get(8_643)).toBe("0.0.0.0");
  });

  it("does not replace a wildcard API forward whose release cannot be proved (#13441)", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "hermes-test", agent: "hermes", dashboardPort: 18_790, hermesApiPort: 8_643 },
        ],
      }),
      initialStates: new Map([
        [18_790, "owned"],
        [8_643, "owned"],
      ]),
      initialHosts: new Map([
        [18_790, "0.0.0.0"],
        [8_643, "0.0.0.0"],
      ]),
    });
    test.retireLegacyForward.mockImplementationOnce(async (request) => ({
      state: "release_unproved",
      forward: request.forward,
      effect: "possible",
      error: { kind: "cleanup", message: "NemoClaw could not prove OpenShell forward cleanup." },
    }));
    await expect(
      test.helpers.ensureFinalizationAgentDashboardForward("hermes-test", loadAgent("hermes")),
    ).rejects.toThrow("could not prove OpenShell forward cleanup");
    expect(
      test.startForward.mock.calls.filter(([request]) => request.forward.port === 8_643),
    ).toHaveLength(1);
    expect(test.hosts.get(8_643)).toBe("0.0.0.0");
  });

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

  it.each(["foreign", "indeterminate"] as const)(
    "refuses a %s auxiliary listener without retiring or replacing it (#13441)",
    async (state) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      const test = harness({
        isWsl: true,
        listSandboxes: () => ({
          sandboxes: [
            { name: "hermes-test", agent: "hermes", dashboardPort: 18_790, hermesApiPort: 8_643 },
          ],
        }),
        initialStates: new Map([
          [18_790, "owned"],
          [8_643, state],
        ]),
      });

      await expect(
        test.helpers.ensureFinalizationAgentDashboardForward("hermes-test", loadAgent("hermes")),
      ).rejects.toThrow(/foreign listener|could not prove/u);
      expect(test.states.get(8_643)).toBe(state);
      expect(test.retireLegacyForward).not.toHaveBeenCalled();
      expect(
        test.startForward.mock.calls.filter(([request]) => request.forward.port === 8_643),
      ).toHaveLength(1);
      expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
    },
  );

  it("rejects a changed sandbox identity before starting the API forward (#13441)", async () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:18790");
    const test = harness({
      isWsl: true,
      listSandboxes: () => ({
        sandboxes: [
          { name: "hermes-test", agent: "hermes", dashboardPort: 18_790, hermesApiPort: 8_643 },
        ],
      }),
    });
    let changed = false;
    await expect(
      test.helpers.ensureFinalizationAgentDashboardForward(
        "hermes-test",
        loadAgent("hermes"),
        () => {
          expect(changed, "sandbox identity changed").toBe(false);
        },
        {
          releaseBeforeForward: (_name, port) => {
            changed = port === 8_643;
          },
        },
      ),
    ).rejects.toThrow("sandbox identity changed");
    expect(test.startForward.mock.calls.map(([request]) => request.forward.port)).toEqual([18_790]);
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
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
