// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ForwardServiceTarget } from "../../src/lib/adapters/openshell/forward-service";
import { createOnboardDashboardHelpers } from "../../src/lib/onboard/dashboard";
import type { ListSandboxesFn } from "../../src/lib/onboard/dashboard-port";

function harness(options: {
  listSandboxes: ListSandboxesFn;
  isPortBound?: (port: number) => boolean;
  matchesListener?: (target: ForwardServiceTarget) => boolean;
}) {
  const launch = vi.fn();
  const matchesListener = vi.fn(options.matchesListener ?? (() => false));
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
    forwardService: {
      executable: () => "/usr/local/bin/openshell",
      launch,
      matchesListener,
      resolveGatewayName: () => "nemoclaw",
      retireLegacy: vi.fn(() => 0),
    },
  });
  return { helpers, launch, matchesListener };
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
    );
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("fails closed when a foreign listener occupies the persisted port", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
    });

    expect(() => helpers.ensureFinalizationDashboardForward("reonboard-test")).toThrow(
      /cannot be reallocated/u,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("retains the exact OpenClaw forward service on repeated onboarding (#11074)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, matchesListener } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
      matchesListener: () => true,
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(18_790);
    expect(matchesListener).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayName: "nemoclaw",
        sandboxName: "reonboard-test",
        localPort: 18_790,
        targetPort: 18_790,
      }),
    );
    expect(launch).not.toHaveBeenCalled();
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("does not retain a forward when another sandbox registers the same port", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, matchesListener } = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18_790 },
          { name: "other", dashboardPort: 18_790 },
        ],
      }),
      isPortBound: (port) => port === 18_790,
      matchesListener: () => true,
    });

    expect(() => helpers.ensureFinalizationDashboardForward("reonboard-test")).toThrow(
      /cannot be reallocated/u,
    );
    expect(matchesListener).not.toHaveBeenCalled();
  });

  it("enables retained-forward matching only for OpenClaw agents", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const openClaw = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
      matchesListener: () => true,
    });

    await expect(
      openClaw.helpers.ensureFinalizationAgentDashboardForward("reonboard-test", {
        name: "openclaw",
        forwardPort: 18_790,
      }),
    ).resolves.toBe(18_790);

    const hermes = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
      matchesListener: () => true,
    });

    await expect(
      hermes.helpers.ensureFinalizationAgentDashboardForward("reonboard-test", {
        name: "hermes",
        forwardPort: 18_790,
      }),
    ).rejects.toThrow(/cannot be reallocated/u);
    expect(hermes.matchesListener).not.toHaveBeenCalled();
  });

  it("honors an explicit dashboard URL", () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:19001");
    const { helpers, launch } = harness({
      listSandboxes: () => ({ sandboxes: [] }),
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(19_001);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ localPort: 19_001 }));
  });
});
