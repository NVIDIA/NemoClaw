// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { HermesForwardWatcherHost } from "../../src/lib/adapters/openshell/hermes-forward-watcher";
import type {
  OnboardDashboardDeps,
  OnboardDashboardHelpers,
} from "../../src/lib/onboard/dashboard";
import {
  createWatcherHost,
  managedCommandLine,
  seedWatcherPidFile,
  stateDirFor,
  withTempHome,
} from "../helpers/hermes-forward-watcher-test-fixture";

const { createOnboardDashboardHelpers } = require("../../src/lib/onboard/dashboard") as {
  createOnboardDashboardHelpers: (deps: OnboardDashboardDeps) => OnboardDashboardHelpers;
};

const SANDBOX = "hermes";
const PORT = 8642;

function createForwardHelpers(
  hermesForwardWatcherHost: HermesForwardWatcherHost,
  hermesForwardWatcherStateDir: string,
  forwardStartDiagnostic = "",
) {
  const startedRow = `${SANDBOX} 127.0.0.1 ${String(PORT)} 42001 running`;
  const forwardList = ["SANDBOX BIND PORT PID STATUS", forwardStartDiagnostic ? "" : startedRow]
    .filter(Boolean)
    .join("\n");
  const runOpenshell = vi.fn(() => ({ status: 0 }));
  const runCaptureOpenshell = vi.fn((args: string[]) =>
    args.join(" ") === "forward list" ? forwardList : "",
  );
  const helpers = createOnboardDashboardHelpers({
    runOpenshell,
    runCaptureOpenshell,
    runCapture: vi.fn(() => ""),
    openshellArgv: () => [
      process.execPath,
      "-e",
      `require("node:fs").writeSync(2, ${JSON.stringify(forwardStartDiagnostic)})`,
    ],
    cliName: () => "nemoclaw",
    agentProductName: () => "NemoClaw",
    getProviderLabel: (provider: string) => provider,
    note: vi.fn(),
    isWsl: () => false,
    redact: (value: unknown) => String(value),
    sleep: vi.fn(),
    isPortBoundOnHost: () => false,
    printAgentDashboardUi: vi.fn(),
    listSandboxes: () => ({ sandboxes: [] }),
    hermesForwardWatcherHost,
    hermesForwardWatcherStateDir,
  });
  return { helpers, runOpenshell };
}

describe("onboard forward start reaps a stale Hermes forward watcher (#10385)", () => {
  it("stops an owned watcher racing the same sandbox port before starting the forward", () => {
    withTempHome("onboard-reap", (home) => {
      const watcher = seedWatcherPidFile(home, 60642, SANDBOX, String(PORT));
      const { host, killed, logs } = createWatcherHost(home, watcher, { pid: 60642 });
      const { helpers } = createForwardHelpers(host, stateDirFor(home));

      expect(
        helpers.ensureDashboardForward(SANDBOX, `http://127.0.0.1:${String(PORT)}`, {
          allowPortReallocation: false,
        }),
      ).toBe(PORT);

      expect(killed).toContain(60642);
      expect(logs).toContain("Stopped Hermes forward watcher 60642");
    });
  });

  it("never signals a foreign-owned process holding the watcher PID file", () => {
    withTempHome("onboard-foreign", (home) => {
      const watcher = seedWatcherPidFile(home, 70642, SANDBOX, String(PORT));
      const { host, killed } = createWatcherHost(home, watcher, {
        owner: "someone-else",
        pid: 70642,
      });
      const { helpers } = createForwardHelpers(host, stateDirFor(home));

      expect(
        helpers.ensureDashboardForward(SANDBOX, `http://127.0.0.1:${String(PORT)}`, {
          allowPortReallocation: false,
        }),
      ).toBe(PORT);

      expect(killed).toHaveLength(0);
    });
  });

  it("never signals an unrelated command line reusing the watcher PID", () => {
    withTempHome("onboard-unrelated", (home) => {
      const watcher = seedWatcherPidFile(home, 71642, SANDBOX, String(PORT));
      const { host, killed } = createWatcherHost(home, watcher, {
        commandLine: `/bin/sh -c ${managedCommandLine(watcher)}`,
        pid: 71642,
      });
      const { helpers } = createForwardHelpers(host, stateDirFor(home));

      expect(
        helpers.ensureDashboardForward(SANDBOX, `http://127.0.0.1:${String(PORT)}`, {
          allowPortReallocation: false,
        }),
      ).toBe(PORT);

      expect(killed).toHaveLength(0);
    });
  });

  it("names a surviving managed watcher when the forward listener fails to open", () => {
    withTempHome("onboard-diagnostic", (home) => {
      const watcher = seedWatcherPidFile(home, 72642, SANDBOX, String(PORT));
      const { host } = createWatcherHost(home, watcher, { exitsOnSignal: false, pid: 72642 });
      const diagnostic = `local forward listener did not open on 127.0.0.1:${String(PORT)} within 10000ms\n`;
      const { helpers } = createForwardHelpers(host, stateDirFor(home), diagnostic);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const restore = () => warnSpy.mockRestore();
      const warnings = (() => {
        try {
          helpers.ensureDashboardForward(SANDBOX, `http://127.0.0.1:${String(PORT)}`, {
            allowPortReallocation: false,
          });
          return warnSpy.mock.calls.map(([line]) => String(line)).join("\n");
        } finally {
          restore();
        }
      })();

      expect(warnings).toContain("Hermes forward watcher");
      expect(warnings).toContain("72642");
      expect(warnings).toContain(watcher.watcherScript);
    });
  });
});
