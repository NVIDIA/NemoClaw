// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const { getPortConflictServiceHints } = require("../dist/lib/onboard") as {
  getPortConflictServiceHints: (platform?: string) => string[];
};
const { createOnboardDashboardHelpers } = require("../dist/lib/onboard/dashboard") as {
  createOnboardDashboardHelpers: (deps: Record<string, unknown>) => {
    ensureDashboardForward: (sandboxName: string, chatUiUrl?: string) => number;
  };
};

describe("onboard dashboard helpers", () => {
  it("prints platform-appropriate service hints for port conflicts", () => {
    expect(getPortConflictServiceHints("darwin").join("\n")).toMatch(/launchctl unload/);
    expect(getPortConflictServiceHints("darwin").join("\n")).not.toMatch(/systemctl --user/);
    expect(getPortConflictServiceHints("linux").join("\n")).toMatch(
      /systemctl --user stop openclaw-gateway.service/,
    );
  });

  it("uses sandbox-scoped forward stops for same-sandbox dashboard cleanup", () => {
    const forwardList =
      "SANDBOX BIND PORT PID STATUS\n" +
      "my-sandbox 127.0.0.1 18789 12345 running\n" +
      "my-sandbox 127.0.0.1 19000 12346 running";
    const runOpenshell = vi.fn((_args: string[], _opts?: Record<string, unknown>) => ({
      status: 0,
    }));
    const runCaptureOpenshell = vi.fn((args: string[], _opts?: Record<string, unknown>) =>
      args.join(" ") === "forward list" ? forwardList : "",
    );
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell,
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
    });

    expect(helpers.ensureDashboardForward("my-sandbox", "http://127.0.0.1:18789")).toBe(18789);

    const stopArgs = runOpenshell.mock.calls.map(([args]) => args);
    expect(stopArgs).toContainEqual(["forward", "stop", "18789", "my-sandbox"]);
    expect(stopArgs).toContainEqual(["forward", "stop", "19000", "my-sandbox"]);
    expect(
      stopArgs.some(
        (args) =>
          Array.isArray(args) &&
          args[0] === "forward" &&
          args[1] === "stop" &&
          args.length === 3,
      ),
    ).toBe(false);
  });
});
