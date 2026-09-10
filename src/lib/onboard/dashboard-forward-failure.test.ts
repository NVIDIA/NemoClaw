// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOnboardDashboardHelpers } from "./dashboard";

const createdHomes: string[] = [];

type LauncherDeps = Parameters<typeof createOnboardDashboardHelpers>[0];

const WIDE_URL = "https://dashboard.example.test:18789";
const LOOPBACK_URL = "http://127.0.0.1:18789";

/** A launcher whose forward service behaves as `launch` says, with the sandbox kept (no rollback). */
function launcherWith(
  launch: () => void,
  recordDashboardBind: (sandboxName: string, bindAddress: string | null) => boolean = () => true,
  overrides: Partial<LauncherDeps> = {},
) {
  return createOnboardDashboardHelpers({
    recordDashboardBind,
    runOpenshell: () => ({ status: 0 }),
    runCaptureOpenshell: () => "SANDBOX BIND PORT PID STATUS",
    openshellArgv: (args: string[]) => ["openshell", ...args],
    cliName: () => "nemoclaw",
    agentProductName: () => "NemoHermes",
    getProviderLabel: (provider: string) => provider,
    note: () => {},
    isWsl: () => false,
    redact: (value: unknown) => String(value),
    sleep: () => {},
    printAgentDashboardUi: () => {},
    listSandboxes: () => ({ sandboxes: [] }),
    isPortBoundOnHost: () => false,
    getSandbox: () => ({ gatewayName: "nemoclaw", gatewayPort: 8080 }),
    forwardService: {
      executable: () => "/usr/local/bin/openshell",
      launch,
      resolveGatewayName: () => "nemoclaw",
      retireLegacy: () => 0,
    },
    ...overrides,
  });
}

describe("the dashboard launcher records the bind of the forward it starts (#10861)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("records the bind before the forward starts and keeps it when the forward comes up", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const record = vi.fn(() => true);
    const launch = vi.fn();
    const helpers = launcherWith(launch, record);

    expect(helpers.ensureDashboardForward("hm", WIDE_URL)).toBe(18789);

    expect(record.mock.calls).toEqual([["hm", "0.0.0.0"]]);
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      launch.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("puts the previous record back when the forward does not start", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const record = vi.fn(() => true);
    const helpers = launcherWith(
      () => {
        throw new Error("forward service exited");
      },
      record,
      {
        getSandbox: () => ({
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          dashboardBindAddress: "127.0.0.1",
        }),
      },
    );

    expect(helpers.ensureDashboardForward("hm", WIDE_URL)).toBe(18789);

    expect(record.mock.calls).toEqual([
      ["hm", "0.0.0.0"],
      ["hm", "127.0.0.1"],
    ]);
  });

  it("warns when the previous record cannot be put back", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const record = vi
      .fn(() => true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const helpers = launcherWith(() => {
      throw new Error("forward service exited");
    }, record);

    expect(helpers.ensureDashboardForward("hm", WIDE_URL)).toBe(18789);

    expect(record.mock.calls).toEqual([
      ["hm", "0.0.0.0"],
      ["hm", null],
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be restored"));
  });

  it.each([
    ["the write is rejected", () => false],
    [
      "the write throws",
      () => {
        throw new Error("disk full");
      },
    ],
  ])(
    "refuses to start a wide forward whose exposure cannot be recorded when %s",
    (_case, write) => {
      vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const launch = vi.fn();
      const helpers = launcherWith(launch, vi.fn(write));

      expect(helpers.ensureDashboardForward("hm", WIDE_URL)).toBe(18789);

      expect(launch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Refusing to start the dashboard forward for 'hm' on all interfaces",
        ),
      );
    },
  );

  it("refuses to start a loopback forward over a stale wide record it cannot update", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const launch = vi.fn();
    const helpers = launcherWith(launch, () => false, {
      getSandbox: () => ({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        dashboardBindAddress: "0.0.0.0",
      }),
    });

    expect(helpers.ensureDashboardForward("hm", LOOPBACK_URL)).toBe(18789);

    expect(launch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("on loopback: the registry still records a bind on 0.0.0.0"),
    );
  });

  it("starts a loopback forward over a loopback record when the write fails, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const launch = vi.fn();
    const helpers = launcherWith(launch, () => false);

    expect(helpers.ensureDashboardForward("hm", LOOPBACK_URL)).toBe(18789);

    expect(launch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be recorded"));
  });

  it("leaves the record alone when it keeps an owned forward", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const record = vi.fn(() => true);
    const launch = vi.fn();
    const helpers = launcherWith(launch, record, {
      listSandboxes: () => ({ sandboxes: [{ name: "hm", dashboardPort: 18789 }] }),
      isPortBoundOnHost: () => true,
      forwardService: {
        executable: () => "/usr/local/bin/openshell",
        launch,
        owns: () => true,
        resolveGatewayName: () => "nemoclaw",
        retireLegacy: () => 0,
      },
    });

    expect(
      helpers.ensureDashboardForward("hm", WIDE_URL, { reuseExistingOpenClawForward: true }),
    ).toBe(18789);

    expect(launch).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("a reused forward that does not start leaves the registry saying what it said (#10861)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const home of createdHomes.splice(0)) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("puts the loopback record back through the real launcher, reuse path and registry", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-reused-forward-"));
    createdHomes.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = await import("../state/registry");
    const { createOnboardDashboardHelpers: createHelpers } = await import("./dashboard");
    const { applyReusedSandboxDashboardState } = await import("./sandbox-reuse");
    const { runDashboardUrlCommand } = await import("../dashboard-url-command");
    registry.registerSandbox({
      name: "reuse-me",
      agent: "hermes",
      dashboardPort: 18789,
      dashboardBindAddress: "127.0.0.1",
      dashboardRemoteBindPrepared: true,
      gatewayName: "nemoclaw-8080",
      gatewayPort: 8080,
    });
    const helpers = createHelpers({
      runOpenshell: () => ({ status: 0 }),
      runCaptureOpenshell: () => "SANDBOX BIND PORT PID STATUS",
      openshellArgv: (args: string[]) => ["openshell", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoHermes",
      getProviderLabel: (provider: string) => provider,
      note: () => {},
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: () => {},
      printAgentDashboardUi: () => {},
      listSandboxes: () => ({ sandboxes: [] }),
      isPortBoundOnHost: () => false,
      getSandbox: registry.getSandbox,
      recordDashboardBind: (name, bind) =>
        registry.updateSandbox(name, { dashboardBindAddress: bind }),
      forwardService: {
        executable: () => "/usr/local/bin/openshell",
        launch: () => {
          throw new Error("forward service exited");
        },
        resolveGatewayName: () => "nemoclaw-8080",
        retireLegacy: () => 0,
      },
    });

    applyReusedSandboxDashboardState({
      sandboxName: "reuse-me",
      chatUiUrl: WIDE_URL,
      env: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
      agent: null,
      model: "test-model",
      provider: "openai-compatible",
      selectionVerified: true,
      sandboxGpuConfig: {
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        mode: "auto",
        sandboxGpuDevice: null,
        errors: [],
      },
      gatewayName: "nemoclaw-8080",
      gatewayPort: 8080,
      getSandbox: registry.getSandbox,
      ensureDashboardForward: helpers.ensureDashboardForward,
      hermesDashboardForwarding: {
        resolveStateForPort: () => ({ enabled: false, config: null }),
        ensureForState: () => {},
      },
      updateSandbox: registry.updateSandbox,
      updateReusedSandboxMetadata: () => {},
    });

    expect(registry.getSandbox("reuse-me")?.dashboardBindAddress).toBe("127.0.0.1");
    const out: string[] = [];
    runDashboardUrlCommand(
      "reuse-me",
      { quiet: false },
      {
        fetchToken: () => "unused",
        getSandbox: registry.getSandbox,
        getAgentDashboardAuth: () => "session",
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
        log: (message) => out.push(message),
        error: () => undefined,
      },
    );
    expect(out.join("\n")).not.toContain("Bound on all interfaces");
    expect(out).toContain("      ssh -L 18789:127.0.0.1:18789 spark@<host>");
  });
});

describe("a fresh agent forward that does not start leaves no record behind (#10861)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const home of createdHomes.splice(0)) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("leaves no wide record behind through the real launcher, agent path and registry", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-fresh-forward-"));
    createdHomes.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("CHAT_UI_URL", WIDE_URL);
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = await import("../state/registry");
    const { createOnboardDashboardHelpers: createHelpers } = await import("./dashboard");
    const { runDashboardUrlCommand } = await import("../dashboard-url-command");
    // Finalization published this row with no bind; the launcher records the
    // bind only when it starts the agent forward.
    registry.registerSandbox({
      name: "hm",
      agent: "hermes",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
      gatewayName: "nemoclaw-8080",
      gatewayPort: 8080,
    });
    const recorded: Array<string | null> = [];
    const helpers = createHelpers({
      runOpenshell: () => ({ status: 0 }),
      runCaptureOpenshell: () => "SANDBOX BIND PORT PID STATUS",
      openshellArgv: (args: string[]) => ["openshell", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoHermes",
      getProviderLabel: (provider: string) => provider,
      note: () => {},
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: () => {},
      printAgentDashboardUi: () => {},
      listSandboxes: () => ({ sandboxes: [] }),
      isPortBoundOnHost: () => false,
      getSandbox: registry.getSandbox,
      recordDashboardBind: (name, bind) => {
        recorded.push(bind);
        return registry.updateSandbox(name, { dashboardBindAddress: bind });
      },
      forwardService: {
        executable: () => "/usr/local/bin/openshell",
        launch: () => {
          throw new Error("forward service exited");
        },
        resolveGatewayName: () => "nemoclaw-8080",
        retireLegacy: () => 0,
      },
    });

    await expect(
      helpers.ensureFinalizationAgentDashboardForward("hm", { name: "hermes" }),
    ).resolves.toBe(18789);

    expect(recorded).toEqual(["0.0.0.0", null]);
    expect(registry.getSandbox("hm")?.dashboardBindAddress ?? null).toBeNull();
    const out: string[] = [];
    runDashboardUrlCommand(
      "hm",
      { quiet: false },
      {
        fetchToken: () => "unused",
        getSandbox: registry.getSandbox,
        getAgentDashboardAuth: () => "session",
        env: {},
        log: (message) => out.push(message),
        error: () => undefined,
      },
    );
    expect(out.join("\n")).not.toContain("Bound on all interfaces");
    expect(out.join("\n")).toContain("no recorded bind for this dashboard forward");
  });

  it("warns when the record cannot be put back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("CHAT_UI_URL", WIDE_URL);
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const record = vi
      .fn(() => true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const helpers = launcherWith(() => {
      throw new Error("forward service exited");
    }, record);

    await expect(
      helpers.ensureFinalizationAgentDashboardForward("hm", { name: "hermes" }),
    ).resolves.toBe(18789);

    expect(record.mock.calls).toEqual([
      ["hm", "0.0.0.0"],
      ["hm", null],
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be restored"));
  });

  it("records the bind once when the forward starts", async () => {
    vi.stubEnv("CHAT_UI_URL", WIDE_URL);
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const record = vi.fn(() => true);
    const helpers = launcherWith(() => undefined, record);

    await expect(
      helpers.ensureFinalizationAgentDashboardForward("hm", { name: "hermes" }),
    ).resolves.toBe(18789);

    expect(record.mock.calls).toEqual([["hm", "0.0.0.0"]]);
  });
});
