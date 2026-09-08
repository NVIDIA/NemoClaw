// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOnboardDashboardHelpers } from "./dashboard";

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
