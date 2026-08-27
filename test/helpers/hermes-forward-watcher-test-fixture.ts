// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";
import type {
  HermesForwardWatcherHost,
  HermesForwardWatcherState,
} from "../../src/lib/adapters/openshell/hermes-forward-watcher";

type RunResult = { status: number | null; stderr: string; stdout: string };

export type WatcherProcessFixture = {
  commandLine?: string;
  exitsOnSignal?: boolean;
  owner?: string;
  pid: number;
};

export function seedWatcherPidFile(
  home: string,
  pid: number,
  sandbox: string,
  port: string,
): HermesForwardWatcherState {
  const stateDir = path.join(home, ".nemoclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pidFile = path.join(stateDir, `hermes-${sandbox}-${port}.forward.pid`);
  fs.writeFileSync(pidFile, `${String(pid)}\n`);
  return { pid, pidFile, port, sandbox, watcherScript: `${pidFile}.js` };
}

export function managedCommandLine(watcher: HermesForwardWatcherState): string {
  return `/usr/bin/node ${watcher.watcherScript} /usr/local/bin/openshell ${watcher.port} ${watcher.sandbox}`;
}

export function createWatcherHost(
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

export function stateDirFor(home: string): string {
  return path.join(home, ".nemoclaw", "state");
}

export function withTempHome<T>(label: string, body: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-10385-${label}-`));
  try {
    return body(home);
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
}
