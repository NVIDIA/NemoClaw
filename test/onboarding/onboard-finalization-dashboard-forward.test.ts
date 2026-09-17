// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../src/lib/agent/defs";
import type {
  ObserveOpenShellForwardsRequest,
  OpenShellForwardAdapter,
  OpenShellForwardIdentity,
  OpenShellForwardObservation,
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
              kind: "command" as const,
              message: "The OpenShell forward command failed." as const,
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
  const runCaptureOpenshell = vi.fn(() => "");
  const runOpenshell = vi.fn((args: string[]) => {
    if (
      args[0] === "forward" &&
      args[1] === "start" &&
      options.startFailurePort !== undefined &&
      args[3]?.endsWith(`:${String(options.startFailurePort)}`)
    ) {
      return { status: 1 };
    }
    return { status: 0 };
  });
  const helpers = createOnboardDashboardHelpers({
    runCaptureOpenshell,
    runOpenshell,
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
  return {
    helpers,
    observeForwards,
    retireLegacyForward,
    runCaptureOpenshell,
    runOpenshell,
    startForward,
    states,
  };
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

  it("starts the persisted dashboard forward with one OpenShell command", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      initialStates: new Map([[18_790, "indeterminate"]]),
    });

    await expect(test.helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      18_790,
    );
    expect(test.runOpenshell).toHaveBeenCalledWith(
      [
        "forward",
        "start",
        "-d",
        "127.0.0.1:18790",
        "reonboard-test",
        "--gateway",
        "nemoclaw",
        "--gateway-endpoint",
        "https://127.0.0.1:8080",
        "--workspace",
        "default",
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 15_000,
        killProcessTreeOnTimeout: true,
      },
    );
    expect(test.observeForwards).not.toHaveBeenCalled();
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(test.startForward).not.toHaveBeenCalled();
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("lets OpenShell decide whether a registered port can be forwarded", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18_790 },
          { name: "other", dashboardPort: 18_790 },
        ],
      }),
    });

    await expect(test.helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      18_790,
    );
    expect(test.runOpenshell).toHaveBeenCalledOnce();
    expect(test.observeForwards).not.toHaveBeenCalled();
  });

  it("issues one OpenShell start command for each Hermes forward", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const test = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790, hermesApiPort: 8_643 }],
      }),
    });

    await expect(
      test.helpers.ensureFinalizationAgentDashboardForward("reonboard-test", loadAgent("hermes")),
    ).resolves.toBe(18_790);
    expect(test.runOpenshell.mock.calls.map(([args]) => args[3])).toEqual([
      "127.0.0.1:18790",
      "127.0.0.1:8643",
    ]);
    expect(test.observeForwards).not.toHaveBeenCalled();
  });

  it("reports an OpenShell command failure without inspecting forward state", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const test = harness({
      listSandboxes: () => ({ sandboxes: [{ name: "reonboard-test" }] }),
      startFailurePort: 8_642,
    });

    await expect(
      test.helpers.ensureAgentFixedForward("reonboard-test", 8_642, "Hermes API"),
    ).resolves.toBe(false);
    expect(test.runOpenshell).toHaveBeenCalledOnce();
    expect(test.observeForwards).not.toHaveBeenCalled();
  });

  it("honors an explicit dashboard URL", async () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:19001");
    const test = harness({ listSandboxes: () => ({ sandboxes: [] }) });

    await expect(test.helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      19_001,
    );
    expect(test.runOpenshell.mock.calls[0]?.[0]?.[3]).toBe("127.0.0.1:19001");
  });
});
