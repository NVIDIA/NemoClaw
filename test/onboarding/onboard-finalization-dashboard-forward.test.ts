// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createOnboardDashboardHelpers } from "../../src/lib/onboard/dashboard";
import type { ListSandboxesFn } from "../../src/lib/onboard/dashboard-port";

function harness(options: {
  listSandboxes: ListSandboxesFn;
  isPortBound?: (port: number) => boolean;
  sandboxIdentity?: () => string;
  stopSandbox?: (sandboxName: string) => { exitCode: number; message?: string };
  startSandbox?: (sandboxName: string) => Promise<{ exitCode: number; message?: string }>;
}) {
  const launch = vi.fn();
  const stopSandbox = vi.fn(options.stopSandbox ?? (() => ({ exitCode: 0 })));
  const startSandbox = vi.fn(options.startSandbox ?? (async () => ({ exitCode: 0 })));
  const helpers = createOnboardDashboardHelpers({
    runOpenshell: vi.fn(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn((args) =>
      args[0] === "sandbox"
        ? `Name: reonboard-test\nId: ${options.sandboxIdentity?.() ?? "sandbox-id"}\nState: Ready\n`
        : "",
    ),
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
    getSandbox: () => ({ gatewayName: "nemoclaw", dashboardPort: 18_790 }),
    isPortBoundOnHost: options.isPortBound ?? (() => false),
    stopSandboxForDashboardReuse: stopSandbox,
    startSandboxForDashboardReuse: startSandbox,
    forwardService: {
      executable: () => "/usr/local/bin/openshell",
      launch,
      resolveGatewayName: () => "nemoclaw",
      retireLegacy: vi.fn(() => 0),
    },
  });
  return { helpers, launch, startSandbox, stopSandbox };
}

describe("finalization dashboard ForwardTcp launch", () => {
  it("launches the persisted dashboard port and publishes its URL", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
    });

    await expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      18_790,
    );
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

  it("fails closed when a foreign listener occupies the persisted port", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
    });

    await expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).rejects.toThrow(
      /cannot be reallocated/u,
    );
    expect(launch).not.toHaveBeenCalled();
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(startSandbox).not.toHaveBeenCalled();
  });

  it("restarts the reused sandbox and retains its registered dashboard port (#11074)", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    const { helpers, launch, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      stopSandbox: () => {
        bound = false;
        return { exitCode: 0 };
      },
      startSandbox: async () => {
        bound = true;
        return { exitCode: 0 };
      },
    });

    await expect(
      helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true),
    ).resolves.toBe(18_790);
    expect(stopSandbox).toHaveBeenCalledWith("reonboard-test");
    expect(startSandbox).toHaveBeenCalledWith("reonboard-test");
    expect(launch).not.toHaveBeenCalled();
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("rejects an ambiguous listener that remains after the reused sandbox stops", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
      startSandbox: async () => ({ exitCode: 1, message: "listener conflict" }),
    });

    await expect(
      helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true),
    ).rejects.toThrow(/remained occupied.*Run 'nemoclaw reonboard-test start'/u);
    expect(stopSandbox).toHaveBeenCalledWith("reonboard-test");
    expect(startSandbox).toHaveBeenCalledWith("reonboard-test");
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not start a same-name replacement after the reused sandbox stops", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    let identity = "original-id";
    const { helpers, launch, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      sandboxIdentity: () => identity,
      stopSandbox: () => {
        bound = false;
        identity = "replacement-id";
        return { exitCode: 0 };
      },
    });

    await expect(
      helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true),
    ).rejects.toThrow(/identity changed.*selected sandbox was stopped/u);
    expect(stopSandbox).toHaveBeenCalledWith("reonboard-test");
    expect(startSandbox).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not reuse a forward when another sandbox registers the same port", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18_790 },
          { name: "other", dashboardPort: 18_790 },
        ],
      }),
      isPortBound: (port) => port === 18_790,
    });

    await expect(
      helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true),
    ).rejects.toThrow(/cannot be reallocated/u);
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("enables lifecycle reconciliation only for OpenClaw agents", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    const openClaw = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      stopSandbox: () => {
        bound = false;
        return { exitCode: 0 };
      },
      startSandbox: async () => {
        bound = true;
        return { exitCode: 0 };
      },
    });

    await expect(
      openClaw.helpers.ensureFinalizationAgentDashboardForward(
        "reonboard-test",
        { name: "openclaw", forwardPort: 18_790 },
        undefined,
        undefined,
        true,
      ),
    ).resolves.toBe(18_790);

    const hermes = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
    });

    await expect(
      hermes.helpers.ensureFinalizationAgentDashboardForward(
        "reonboard-test",
        { name: "hermes", forwardPort: 18_790 },
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow(/cannot be reallocated/u);
    expect(hermes.stopSandbox).not.toHaveBeenCalled();
  });

  it("honors an explicit dashboard URL", async () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:19001");
    const { helpers, launch } = harness({
      listSandboxes: () => ({ sandboxes: [] }),
    });

    await expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      19_001,
    );
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ localPort: 19_001 }));
  });
});
