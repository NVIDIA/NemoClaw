// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ForwardServiceTarget } from "../../src/lib/adapters/openshell/forward-service";
import type { ForwardServiceOwnershipResult } from "../../src/lib/adapters/openshell/forward-service-ownership";
import { loadAgent } from "../../src/lib/agent/defs";
import { createOnboardDashboardHelpers } from "../../src/lib/onboard/dashboard";
import type { OnboardDashboardDeps } from "../../src/lib/onboard/dashboard";
import type { ListSandboxesFn } from "../../src/lib/onboard/dashboard-port";

function harness(options: {
  listSandboxes: ListSandboxesFn;
  getSandbox?: OnboardDashboardDeps["getSandbox"];
  inspectOwnership?: (target: ForwardServiceTarget) => ForwardServiceOwnershipResult;
  isPortBound?: (port: number) => boolean;
}) {
  const launch = vi.fn();
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
    ...(options.getSandbox ? { getSandbox: options.getSandbox } : {}),
    isPortBoundOnHost: options.isPortBound ?? (() => false),
    forwardService: {
      executable: () => "/usr/local/bin/openshell",
      inspectOwnership: options.inspectOwnership,
      launch,
      resolveGatewayName: () => "nemoclaw",
      retireLegacy: vi.fn(() => 0),
    },
  });
  return { helpers, launch };
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

  it("preserves the registered ForwardTcp listener during Ready sandbox reuse (#11074)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const revalidateSandboxIdentity = vi.fn();
    const inspectOwnership = vi.fn(() => {
      expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
        "preserve registered dashboard forward 18790 for sandbox 'reonboard-test'",
      );
      return { owned: true } as const;
    });
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      inspectOwnership,
      isPortBound: (port) => port === 18_790,
    });

    expect(
      helpers.ensureFinalizationDashboardForward("reonboard-test", {
        preserveRegisteredForward: true,
        revalidateSandboxIdentity,
      }),
    ).toBe(18_790);
    expect(inspectOwnership).toHaveBeenCalledWith(
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

  it("preserves the registered Hermes dashboard through agent finalization (#11074)", async () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:18789");
    const revalidateSandboxIdentity = vi.fn();
    const inspectOwnership = vi.fn(() => ({ owned: true }) as const);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "hermes-reuse", dashboardPort: 18_789 }],
      }),
      getSandbox: () => ({ hermesApiPort: 8647 }) as never,
      inspectOwnership,
      isPortBound: (port) => port === 18_789,
    });

    expect(
      await helpers.ensureFinalizationAgentDashboardForward("hermes-reuse", loadAgent("hermes"), {
        preserveRegisteredForward: true,
        revalidateSandboxIdentity,
      }),
    ).toBe(18_789);
    expect(inspectOwnership).toHaveBeenCalledOnce();
    expect(inspectOwnership).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "hermes-reuse",
        localPort: 18_789,
        targetPort: 18_789,
      }),
    );
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "hermes-reuse",
        localPort: 8647,
        targetPort: 8647,
      }),
    );
  });

  it("rejects an unowned listener during Ready sandbox reuse (#11074)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      inspectOwnership: () => ({ owned: false, failure: "process-identity-mismatch" }),
      isPortBound: (port) => port === 18_790,
    });

    expect(() =>
      helpers.ensureFinalizationDashboardForward("reonboard-test", {
        preserveRegisteredForward: true,
      }),
    ).toThrow(
      /port 18790 for sandbox 'reonboard-test'.*process-identity-mismatch.*onboard --resume.*--control-ui-port <N>.*not adopted/su,
    );
    expect(launch).not.toHaveBeenCalled();
    expect(process.env.CHAT_UI_URL).toBeUndefined();
  });

  it.each([
    [
      "listener-changed",
      /port 18790 for sandbox 'reonboard-test'.*listener-changed.*changed during inspection.*onboard --resume/su,
    ],
    [
      "listener-not-unique",
      /port 18790 for sandbox 'reonboard-test'.*listener-not-unique.*stop the extra listener.*onboard --resume/su,
    ],
  ] as const)(
    "reports %s ownership recovery during Ready sandbox reuse (#11074)",
    (failure, message) => {
      vi.stubEnv("CHAT_UI_URL", undefined);
      const { helpers, launch } = harness({
        listSandboxes: () => ({
          sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
        }),
        inspectOwnership: () => ({
          owned: false,
          failure,
        }),
        isPortBound: (port) => port === 18_790,
      });

      expect(() =>
        helpers.ensureFinalizationDashboardForward("reonboard-test", {
          preserveRegisteredForward: true,
        }),
      ).toThrow(message);
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("reports unavailable ownership observation during Ready sandbox reuse (#11074)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      inspectOwnership: () => ({ owned: false, failure: "listener-enumeration-unavailable" }),
      isPortBound: (port) => port === 18_790,
    });

    expect(() =>
      helpers.ensureFinalizationDashboardForward("reonboard-test", {
        preserveRegisteredForward: true,
      }),
    ).toThrow(
      /port 18790 for sandbox 'reonboard-test'.*listener-enumeration-unavailable.*Install lsof or restore read access to Linux \/proc/su,
    );
    expect(launch).not.toHaveBeenCalled();
    expect(process.env.CHAT_UI_URL).toBeUndefined();
  });

  it("does not preserve a reused port registered to another sandbox (#11074)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18_790 },
          { name: "other-sandbox", dashboardPort: 18_790 },
        ],
      }),
      isPortBound: (port) => port === 18_790,
    });

    expect(() =>
      helpers.ensureFinalizationDashboardForward("reonboard-test", {
        preserveRegisteredForward: true,
      }),
    ).toThrow(/cannot be reallocated/u);
    expect(launch).not.toHaveBeenCalled();
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
