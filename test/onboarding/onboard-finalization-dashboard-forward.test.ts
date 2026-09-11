// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  launchForwardService,
  type ForwardServiceLaunchOptions,
  type ForwardServiceTarget,
} from "../../src/lib/adapters/openshell/forward-service";
import { createOnboardDashboardHelpers } from "../../src/lib/onboard/dashboard";
import { loadAgent } from "../../src/lib/agent/defs";
import type { ListSandboxesFn } from "../../src/lib/onboard/dashboard-port";

function harness(options: {
  listSandboxes: ListSandboxesFn;
  isPortBound?: (port: number) => boolean;
  ownsForward?: (target: ForwardServiceTarget) => boolean;
  launch?: typeof launchForwardService;
}) {
  const startedPorts = new Set<number>();
  const launch = vi.fn(
    options.launch ??
      ((target: ForwardServiceTarget, launchOptions?: ForwardServiceLaunchOptions) => {
        startedPorts.add(target.localPort);
        launchOptions?.verifyReady?.();
      }),
  );
  const owns = vi.fn(options.ownsForward ?? ((target) => startedPorts.has(target.localPort)));

  const helpers = createOnboardDashboardHelpers({
    runOpenshell: vi.fn(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn(() => ""),
    openshellArgv: (args) => ["/usr/local/bin/openshell", ...args],
    cliName: () => "nemoclaw",
    agentProductName: () => "NemoClaw",
    getProviderLabel: (provider) => provider,
    note: vi.fn(),
    isWsl: () => false,
    redact: String,
    sleep: vi.fn(),
    printAgentDashboardUi: vi.fn(),
    listSandboxes: options.listSandboxes,
    isPortBoundOnHost: options.isPortBound ?? (() => false),
    getSandbox: (name) => options.listSandboxes().sandboxes.find((entry) => entry.name === name),
    forwardService: {
      executable: () => "/usr/local/bin/openshell",
      launch,
      owns,
      resolveGatewayName: () => "nemoclaw",
      retireLegacy: vi.fn(() => 0),
    },
  });
  return { helpers, launch, owns };
}

describe("finalization dashboard ForwardTcp launch", () => {
  it("launches the persisted dashboard port and publishes its URL", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(18_790);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayName: "nemoclaw",
        sandboxName: "reonboard-test",
        localPort: 18_790,
        targetPort: 18_790,
      }),
      expect.objectContaining({ verifyReady: expect.any(Function) }),
    );
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("fails closed when a foreign or ambiguous listener occupies the persisted port", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
    });

    expect(() => helpers.ensureFinalizationDashboardForward("reonboard-test")).toThrow(
      /cannot be reallocated or adopted/u,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("reuses an exactly owned dashboard forward (#11074)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, owns } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
      ownsForward: () => true,
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(18_790);
    expect(owns).toHaveBeenCalledOnce();
    expect(owns).toHaveBeenCalledWith({
      executable: "/usr/local/bin/openshell",
      gatewayName: "nemoclaw",
      workspace: "default",
      sandboxName: "reonboard-test",
      localHost: "127.0.0.1",
      localPort: 18_790,
      targetHost: "127.0.0.1",
      targetPort: 18_790,
    });
    expect(launch).not.toHaveBeenCalled();
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("does not reuse a forward when another sandbox registers the same port", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18_790 },
          { name: "other", dashboardPort: 18_790 },
        ],
      }),
      isPortBound: (port) => port === 18_790,
    });

    expect(() => helpers.ensureFinalizationDashboardForward("reonboard-test")).toThrow(
      /not available/u,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["openclaw", "hermes"])(
    "reuses registered forwards for %s without launching another listener (#11425)",
    async (name) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      const agent = loadAgent(name);
      const ports = name === "openclaw" ? [18790] : [18790, 8643];
      const { helpers, launch, owns } = harness({
        listSandboxes: () => ({
          sandboxes: [
            { name: "reonboard-test", dashboardPort: 18790, hermesApiPort: 8643 },
            { name: "sibling", dashboardPort: 18789, hermesApiPort: 8642 },
          ],
        }),
        isPortBound: () => true,
        ownsForward: (target) => ports.includes(target.localPort),
      });
      await expect(
        helpers.ensureFinalizationAgentDashboardForward("reonboard-test", agent),
      ).resolves.toBe(18790);
      expect(owns.mock.calls.map(([target]) => target.localPort)).toEqual(ports);
      expect(launch).not.toHaveBeenCalled();
      expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
    },
  );

  it.each([18790, 8643])(
    "establishes missing Hermes forward %s on its recorded port",
    async (missingPort) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      const { helpers, launch } = harness({
        listSandboxes: () => ({
          sandboxes: [{ name: "reonboard-test", dashboardPort: 18790, hermesApiPort: 8643 }],
        }),
        isPortBound: (port) => port !== missingPort,
        ownsForward: () => true,
      });
      await expect(
        helpers.ensureFinalizationAgentDashboardForward("reonboard-test", loadAgent("hermes")),
      ).resolves.toBe(18790);
      expect(launch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          localPort: missingPort,
          targetPort: missingPort,
        }),
        expect.objectContaining({ verifyReady: expect.any(Function) }),
      );
    },
  );

  it.each([
    { state: "foreign", launches: 0 },
    { state: "sibling", launches: 0 },
    { state: "launch-failure", launches: 1 },
    { state: "ownership-changed", launches: 1 },
  ])("rejects a Hermes API forward with $state state (#11425)", async ({ state, launches }) => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18790, hermesApiPort: 8643 },
          ...(state === "sibling" ? [{ name: "sibling", hermesApiPort: 8643 }] : []),
        ],
      }),
      isPortBound: (port) => port === 18790 || state === "foreign" || state === "sibling",
      ownsForward: (target) => target.localPort === 18790 || state === "sibling",
      ...(state === "launch-failure"
        ? {
            launch: () => {
              throw new Error("forward startup failed");
            },
          }
        : {}),
    });
    await expect(
      helpers.ensureFinalizationAgentDashboardForward("reonboard-test", loadAgent("hermes")),
    ).rejects.toThrow(/occupied|not available|startup failed|ownership/u);
    expect(launch).toHaveBeenCalledTimes(launches);
  });

  it("honors an explicit dashboard URL", () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:19001");
    const { helpers, launch } = harness({
      listSandboxes: () => ({ sandboxes: [] }),
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(19_001);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ localPort: 19_001 }),
      expect.objectContaining({ verifyReady: expect.any(Function) }),
    );
  });

  it.each([
    { failure: "ownership", ownsApi: false, afterLaunch: () => {} },
    {
      failure: "sandbox-identity",
      ownsApi: true,
      afterLaunch: () => {
        throw new Error("Sandbox identity changed");
      },
    },
  ])(
    "retires a newly launched Hermes API forward when $failure changes",
    async ({ ownsApi, afterLaunch }) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      const boundPorts = new Set([18790]);
      const child = { pid: process.pid + 1, unref: vi.fn() };
      const revalidateSandboxIdentity = vi.fn();
      const terminateProcessTree = vi.fn(() => boundPorts.delete(8643));
      const { helpers } = harness({
        listSandboxes: () => ({
          sandboxes: [{ name: "reonboard-test", dashboardPort: 18790, hermesApiPort: 8643 }],
        }),
        isPortBound: (port) => boundPorts.has(port),
        ownsForward: (target) => target.localPort === 18790 || ownsApi,
        launch: (target, options) =>
          launchForwardService(target, {
            ...options,
            isReachable: () => boundPorts.has(target.localPort),
            spawnDetached: () => {
              boundPorts.add(target.localPort);
              revalidateSandboxIdentity.mockImplementation(afterLaunch);
              return child;
            },
            terminateProcessTree,
          }),
      });
      await expect(
        helpers.ensureFinalizationAgentDashboardForward(
          "reonboard-test",
          loadAgent("hermes"),
          revalidateSandboxIdentity,
        ),
      ).rejects.toThrow(/ownership|identity/iu);
      expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(child);
      expect(boundPorts).toEqual(new Set([18790]));
      expect(child.unref).not.toHaveBeenCalled();
      expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
    },
  );
});
