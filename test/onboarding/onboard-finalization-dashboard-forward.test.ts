// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { GATEWAY_PORT } from "../../src/lib/core/ports";
import { createOnboardDashboardHelpers } from "../../src/lib/onboard/dashboard";
import type { ListSandboxesFn } from "../../src/lib/onboard/dashboard-port";

function createFinalizationForwardHarness(options: {
  forwardList: string;
  listSandboxes: ListSandboxesFn;
}) {
  const sandboxes = options.listSandboxes().sandboxes;
  const ownedPorts = new Set(
    sandboxes
      .map((sandbox) => sandbox.dashboardPort)
      .filter((port): port is number => typeof port === "number" && port > 0),
  );
  const controller = {
    inspect: vi.fn((_authority, endpoint) =>
      ownedPorts.has(endpoint.localPort)
        ? {
            disposition: "owned" as const,
            ownsListener: true,
            reachable: true,
            receipt: {} as never,
          }
        : { disposition: "absent" as const, ownsListener: false, reachable: false, receipt: null },
    ),
    ensure: vi.fn((_authority, endpoint) => {
      ownedPorts.add(endpoint.localPort);
      return { action: "started" as const, receipt: {} as never };
    }),
    stop: vi.fn(() => "absent" as const),
    stopPort: vi.fn(() => "absent" as const),
    stopAll: vi.fn(() => 0),
  };
  const runOpenshell = vi.fn((_args: string[], _opts?: Record<string, unknown>) => ({
    status: 0,
  }));
  const runCaptureOpenshell = vi.fn((args: string[], _opts?: Record<string, unknown>) =>
    args.join(" ").startsWith("forward list") ? options.forwardList : "",
  );
  const openshellArgv = vi.fn((args: string[]) => [process.execPath, "-e", "", ...args]);
  const helpers = createOnboardDashboardHelpers({
    runOpenshell,
    runCaptureOpenshell,
    openshellArgv,
    cliName: () => "nemoclaw",
    agentProductName: () => "NemoClaw",
    getProviderLabel: (provider: string) => provider,
    note: vi.fn(),
    isWsl: () => false,
    redact: (value: unknown) => String(value),
    sleep: vi.fn(),
    printAgentDashboardUi: vi.fn(),
    listSandboxes: options.listSandboxes,
    getSandbox: (name) => {
      const sandbox = sandboxes.find((entry) => entry.name === name);
      return {
        ...(sandbox ?? { name }),
        gatewayName: "nemoclaw",
        gatewayPort: GATEWAY_PORT,
        lifecycleGeneration: "test-generation",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
      };
    },
    forwardService: {
      controller,
      executable: () => "/usr/local/bin/openshell",
      stateDirectory: "/private/test-state",
      runExclusive: (_sandboxName, operation) => operation(),
      resolveGatewayName: () => "nemoclaw",
      migrateAuthority: (sandboxName) => ({
        authority: {
          gatewayName: "nemoclaw",
          sandboxIdentityFingerprint: "a".repeat(64),
          sandboxName,
        },
        migrated: false,
        assertCurrent: vi.fn(),
        assertLiveCurrent: vi.fn(),
        completeLegacyMigration: vi.fn(),
        isLegacyMigrationComplete: () => true,
      }),
      retireLegacy: vi.fn(() => 0),
    },
  });
  return { controller, helpers, runOpenshell, openshellArgv };
}

describe("finalization dashboard forward", () => {
  it("prefers the persisted registry port over the default dashboard port when CHAT_UI_URL is unset (#8970)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { controller, helpers, openshellArgv } = createFinalizationForwardHarness({
      forwardList:
        "SANDBOX BIND PORT PID STATUS\n" +
        "baseline 127.0.0.1 18789 42000 running\n" +
        "reonboard-test 127.0.0.1 18790 42001 running",
      listSandboxes: () => ({
        sandboxes: [
          { name: "baseline", dashboardPort: 18789 },
          { name: "reonboard-test", dashboardPort: 18790 },
        ],
      }),
    });

    try {
      expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(18790);
      const warnings = warnSpy.mock.calls.map(([line]) => String(line)).join("\n");
      expect(warnings).not.toContain("is taken");
      expect(controller.ensure).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ localPort: 18_790, targetPort: 18_790 }),
        expect.anything(),
      );
      expect(openshellArgv).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("publishes the established forward port back to CHAT_UI_URL (#8970)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers } = createFinalizationForwardHarness({
      forwardList:
        "SANDBOX BIND PORT PID STATUS\n" + "reonboard-test 127.0.0.1 18790 42001 running",
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18790, scopeGatewayPort: GATEWAY_PORT },
        ],
      }),
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(18790);
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("fails without reallocating when another sandbox holds the persisted port (#8970)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, openshellArgv } = createFinalizationForwardHarness({
      forwardList:
        "SANDBOX BIND PORT PID STATUS\n" +
        "baseline 127.0.0.1 18789 42000 running\n" +
        "other-sandbox 127.0.0.1 18790 42002 running",
      listSandboxes: () => ({
        sandboxes: [
          { name: "baseline", dashboardPort: 18789 },
          { name: "other-sandbox", dashboardPort: 18790 },
          { name: "reonboard-test", dashboardPort: 18790 },
        ],
      }),
    });

    expect(() => helpers.ensureFinalizationDashboardForward("reonboard-test")).toThrow(
      "Port 18790 is not available for 'reonboard-test' and cannot be reallocated.",
    );
    expect(process.env.CHAT_UI_URL).toBeUndefined();
    const startCalls = openshellArgv.mock.calls
      .map(([args]) => args.join(" "))
      .filter((line) => line.startsWith("forward start"));
    expect(startCalls).toEqual([]);
  });

  it("falls back to the default dashboard port when no port is persisted (#8970)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers } = createFinalizationForwardHarness({
      forwardList: "SANDBOX BIND PORT PID STATUS\n" + "my-sandbox 127.0.0.1 18789 42001 running",
      listSandboxes: () => ({ sandboxes: [] }),
    });

    expect(helpers.ensureFinalizationDashboardForward("my-sandbox")).toBe(18789);
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18789");
  });

  it("honors an explicit CHAT_UI_URL override over the persisted port (#8970)", () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:19005");
    const { helpers } = createFinalizationForwardHarness({
      forwardList:
        "SANDBOX BIND PORT PID STATUS\n" + "reonboard-test 127.0.0.1 19005 42001 running",
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18790 }],
      }),
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(19005);
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:19005");
  });

  it("ignores a dashboard port persisted for another gateway scope (#8970)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers } = createFinalizationForwardHarness({
      forwardList:
        "SANDBOX BIND PORT PID STATUS\n" + "reonboard-test 127.0.0.1 18789 42001 running",
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18790, scopeGatewayPort: 9999 }],
      }),
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(18789);
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18789");
  });

  it("ignores a zero persisted dashboard port and uses the default dashboard port (#8970)", () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers } = createFinalizationForwardHarness({
      forwardList:
        "SANDBOX BIND PORT PID STATUS\n" + "reonboard-test 127.0.0.1 18789 42001 running",
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 0 }],
      }),
    });

    expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).toBe(18789);
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18789");
  });
});
