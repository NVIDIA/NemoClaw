// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type {
  HermesForwardWatcherHost,
  HermesForwardWatcherState,
} from "../../src/lib/adapters/openshell/hermes-forward-watcher";
import type {
  OnboardDashboardDeps,
  OnboardDashboardHelpers,
} from "../../src/lib/onboard/dashboard";

const { createOnboardDashboardHelpers } = require("../../src/lib/onboard/dashboard") as {
  createOnboardDashboardHelpers: (deps: OnboardDashboardDeps) => OnboardDashboardHelpers;
};

const SANDBOX = "hermes";
const PORT = 8642;

type RunResult = { status: number | null; stderr: string; stdout: string };

type WatcherProcessFixture = {
  commandLine?: string;
  exitsOnSignal?: boolean;
  owner?: string;
  pid: number;
};

function seedWatcherPidFile(home: string, pid: number): HermesForwardWatcherState {
  const stateDir = path.join(home, ".nemoclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pidFile = path.join(stateDir, `hermes-${SANDBOX}-${String(PORT)}.forward.pid`);
  fs.writeFileSync(pidFile, `${String(pid)}\n`);
  return { pid, pidFile, port: String(PORT), sandbox: SANDBOX, watcherScript: `${pidFile}.js` };
}

function managedCommandLine(watcher: HermesForwardWatcherState): string {
  return `/usr/bin/node ${watcher.watcherScript} /usr/local/bin/openshell ${watcher.port} ${watcher.sandbox}`;
}

function createWatcherHost(
  home: string,
  watcher: HermesForwardWatcherState,
  fixture: WatcherProcessFixture,
) {
  const killed: number[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const liveness = { alive: true };
  const found = (stdout: string): RunResult => ({ status: 0, stdout, stderr: "" });
  const absent = (): RunResult => ({ status: 1, stdout: "", stderr: "" });
  const commandLine = fixture.commandLine ?? managedCommandLine(watcher);
  const run = vi.fn((command: string, args: string[]): RunResult => {
    const key = [command, ...args].join(" ");
    const pid = String(fixture.pid);
    return (
      new Map<string, RunResult>([
        [`ps -p ${pid} -o pid=`, liveness.alive ? found(`${pid}\n`) : absent()],
        [`ps -p ${pid} -o user=`, found(`${fixture.owner ?? "testuser"}\n`)],
        [`ps -ww -p ${pid} -o args=`, found(`${commandLine}\n`)],
      ]).get(key) ?? found("")
    );
  });
  const host: HermesForwardWatcherHost = {
    commandExists: () => true,
    env: { HOME: home, LOGNAME: "testuser" },
    kill: (pid: number) => {
      killed.push(pid);
      liveness.alive = fixture.exitsOnSignal === false;
      return true;
    },
    log: (message: string) => logs.push(message),
    readProcessArgv: undefined,
    run,
    warn: (message: string) => warnings.push(message),
  };
  return { host, killed, logs, warnings };
}

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

function withTempHome<T>(label: string, body: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-10385-${label}-`));
  try {
    return body(home);
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
}

function stateDirFor(home: string): string {
  return path.join(home, ".nemoclaw", "state");
}

describe("onboard forward start reaps a stale Hermes forward watcher (#10385)", () => {
  it("stops an owned watcher racing the same sandbox port before starting the forward", () => {
    withTempHome("reap", (home) => {
      const watcher = seedWatcherPidFile(home, 60642);
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
    withTempHome("foreign", (home) => {
      const watcher = seedWatcherPidFile(home, 70642);
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
    withTempHome("unrelated", (home) => {
      const watcher = seedWatcherPidFile(home, 71642);
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
    withTempHome("diagnostic", (home) => {
      const watcher = seedWatcherPidFile(home, 72642);
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
