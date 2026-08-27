// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  HermesForwardWatcherHost,
  HermesForwardWatcherState,
} from "../../adapters/openshell/hermes-forward-watcher";
import { cleanupSandboxServices } from "./destroy";

const SANDBOX = "hermes";
const PORT = "8642";

type RunResult = { status: number | null; stderr: string; stdout: string };

type WatcherProcessFixture = {
  commandLine?: string;
  owner?: string;
  pid: number;
};

function seedWatcherPidFile(home: string, pid: number): HermesForwardWatcherState {
  const stateDir = path.join(home, ".nemoclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pidFile = path.join(stateDir, `hermes-${SANDBOX}-${PORT}.forward.pid`);
  fs.writeFileSync(pidFile, `${String(pid)}\n`);
  return { pid, pidFile, port: PORT, sandbox: SANDBOX, watcherScript: `${pidFile}.js` };
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
      liveness.alive = false;
      return true;
    },
    log: vi.fn(),
    readProcessArgv: undefined,
    run,
    warn: vi.fn(),
  };
  return { host, killed };
}

function destroyCleanup(
  hermesForwardWatcherHost: HermesForwardWatcherHost,
  hermesForwardWatcherStateDir: string,
  sandboxConfirmedDestroyed = true,
): void {
  cleanupSandboxServices(
    SANDBOX,
    { stopHostServices: false, sandboxConfirmedDestroyed },
    {
      getSandbox: vi.fn(() => null),
      googlechatWebhookTunnelPidDir: (servicePidDir: string) =>
        path.join(servicePidDir, "googlechat"),
      hermesForwardWatcherHost,
      hermesForwardWatcherStateDir,
      rmSync: vi.fn(),
      runOpenshell: vi.fn(() => ({ status: 0 })),
      stopAll: vi.fn(),
      stopGooglechatWebhookTunnel: vi.fn(() => ""),
      unloadOllamaModels: vi.fn(),
    },
  );
}

function withTempHome<T>(label: string, body: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-10385-destroy-${label}-`));
  try {
    return body(home);
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
}

function stateDirFor(home: string): string {
  return path.join(home, ".nemoclaw", "state");
}

describe("destroy reaps the sandbox's Hermes forward watcher (#10385)", () => {
  it("stops the owned watcher a destroyed sandbox would otherwise leave running", () => {
    withTempHome("reap", (home) => {
      const watcher = seedWatcherPidFile(home, 60643);
      const { host, killed } = createWatcherHost(home, watcher, { pid: 60643 });

      destroyCleanup(host, stateDirFor(home));

      expect(killed).toContain(60643);
    });
  });

  it("never signals a foreign-owned process holding the watcher PID file", () => {
    withTempHome("foreign", (home) => {
      const watcher = seedWatcherPidFile(home, 70643);
      const { host, killed } = createWatcherHost(home, watcher, {
        owner: "someone-else",
        pid: 70643,
      });

      destroyCleanup(host, stateDirFor(home));

      expect(killed).toHaveLength(0);
    });
  });

  it("never signals an unrelated command line reusing the watcher PID", () => {
    withTempHome("unrelated", (home) => {
      const watcher = seedWatcherPidFile(home, 71643);
      const { host, killed } = createWatcherHost(home, watcher, {
        commandLine: `/bin/sh -c ${managedCommandLine(watcher)}`,
        pid: 71643,
      });

      destroyCleanup(host, stateDirFor(home));

      expect(killed).toHaveLength(0);
    });
  });

  it("never reaps a still-registered sandbox's watcher when the delete was not confirmed", () => {
    // A failed delete leaves the sandbox registered and still running; the
    // watcher this call would otherwise stop is that live sandbox's own
    // forward self-healing, not an orphan's (#10385).
    withTempHome("unconfirmed", (home) => {
      const watcher = seedWatcherPidFile(home, 72643);
      const { host, killed } = createWatcherHost(home, watcher, { pid: 72643 });

      destroyCleanup(host, stateDirFor(home), false);

      expect(killed).toHaveLength(0);
    });
  });
});
