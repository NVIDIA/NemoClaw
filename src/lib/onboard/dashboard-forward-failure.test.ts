// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOnboardDashboardHelpers } from "./dashboard";

const createdHomes: string[] = [];

/** A launcher whose forward service behaves as `launch` says, with the sandbox kept (no rollback). */
function launcherWith(launch: () => void) {
  return createOnboardDashboardHelpers({
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
  });
}

describe("the dashboard launcher reports a start failure it otherwise swallows (#10861)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells the caller the forward did not start and still returns the port", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onForwardFailure = vi.fn();
    const helpers = launcherWith(() => {
      throw new Error("forward service exited");
    });

    const port = helpers.ensureDashboardForward("reuse-me", "http://127.0.0.1:18789", {
      onForwardFailure,
    });

    expect(port).toBe(18789);
    expect(onForwardFailure).toHaveBeenCalledWith(
      expect.stringContaining("forward service exited"),
    );
  });

  it("says nothing to the caller when the forward starts", () => {
    const onForwardFailure = vi.fn();
    const helpers = launcherWith(() => undefined);

    const port = helpers.ensureDashboardForward("reuse-me", "http://127.0.0.1:18789", {
      onForwardFailure,
    });

    expect(port).toBe(18789);
    expect(onForwardFailure).not.toHaveBeenCalled();
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
      chatUiUrl: "https://dashboard.example.test:18789",
      env: {},
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
