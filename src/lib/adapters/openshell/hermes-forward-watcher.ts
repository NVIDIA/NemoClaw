// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import { sleepMs } from "../../core/wait";
import {
  type HermesForwardWatcherCommandLine,
  type HermesForwardWatcherState,
  isManagedHermesForwardWatcherProcess,
} from "../../domain/uninstall/hermes-forward-watcher";

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

export interface HermesForwardWatcherHost {
  commandExists: (command: string) => boolean;
  env: NodeJS.ProcessEnv;
  kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log: (message: string) => void;
  readProcessArgv: ((pid: number) => readonly string[] | null) | undefined;
  run: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  warn: (message: string) => void;
}

function pidExists(pid: number, host: HermesForwardWatcherHost): boolean {
  return host.run("ps", ["-p", String(pid), "-o", "pid="], { env: host.env }).status === 0;
}

function readProcCommandLine(pid: number): HermesForwardWatcherCommandLine | null {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean);
    return argv.length > 0 ? { kind: "argv", value: argv } : null;
  } catch {
    return null;
  }
}

function readProcessCommandLine(
  pid: number,
  host: HermesForwardWatcherHost,
): HermesForwardWatcherCommandLine | null {
  const injectedArgv = host.readProcessArgv?.(pid);
  const procCommandLine = host.readProcessArgv
    ? injectedArgv && injectedArgv.length > 0
      ? { kind: "argv" as const, value: injectedArgv }
      : null
    : readProcCommandLine(pid);
  if (procCommandLine) return procCommandLine;
  const result = host.run("ps", ["-ww", "-p", String(pid), "-o", "args="], { env: host.env });
  return result.status === 0 && result.stdout.trim() ? { kind: "ps", value: result.stdout } : null;
}

function currentUser(host: HermesForwardWatcherHost): string {
  return host.env.SUDO_USER || host.env.LOGNAME || os.userInfo().username;
}

function processUser(pid: number, host: HermesForwardWatcherHost): string {
  const result = host.run("ps", ["-p", String(pid), "-o", "user="], { env: host.env });
  return result.status === 0 ? result.stdout.trim() : "";
}

function isManagedWatcherRunning(
  watcher: HermesForwardWatcherState,
  host: HermesForwardWatcherHost,
): boolean {
  const pid = watcher.pid;
  if (pid === null || !pidExists(pid, host)) return false;
  return isManagedHermesForwardWatcherProcess({
    commandLine: readProcessCommandLine(pid, host),
    expectedUser: currentUser(host),
    observedUser: processUser(pid, host),
    watcher,
  });
}

function waitForWatcherExit(
  watcher: HermesForwardWatcherState,
  host: HermesForwardWatcherHost,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isManagedWatcherRunning(watcher, host)) return true;
    sleepMs(50);
  }
  return !isManagedWatcherRunning(watcher, host);
}

export function stopHermesForwardWatcherProcess(
  watcher: HermesForwardWatcherState,
  host: HermesForwardWatcherHost,
): boolean {
  const pid = watcher.pid;
  if (pid === null || !isManagedWatcherRunning(watcher, host)) return true;

  host.kill(pid);
  if (waitForWatcherExit(watcher, host, 1000)) {
    host.log(`Stopped Hermes forward watcher ${pid}`);
    return true;
  }
  if (!isManagedWatcherRunning(watcher, host)) {
    host.log(`Stopped Hermes forward watcher ${pid}`);
    return true;
  }
  host.kill(pid, "SIGKILL");
  if (waitForWatcherExit(watcher, host, 1000)) {
    host.log(`Stopped Hermes forward watcher ${pid}`);
    return true;
  }
  host.warn(`Failed to stop Hermes forward watcher ${pid}`);
  return false;
}

export function stopHermesSandboxForward(
  watcher: HermesForwardWatcherState,
  host: HermesForwardWatcherHost,
): boolean {
  if (!host.commandExists("openshell")) {
    host.warn(
      `Failed to stop Hermes forward for sandbox '${watcher.sandbox}' on port ${watcher.port}: openshell is unavailable.`,
    );
    return false;
  }
  const result = host.run("openshell", ["forward", "stop", watcher.port, watcher.sandbox], {
    env: host.env,
  });
  if (result.status === 0) return true;
  host.warn(
    `Failed to stop Hermes forward for sandbox '${watcher.sandbox}' on port ${watcher.port} (exit ${String(result.status ?? "unknown")}).`,
  );
  return false;
}
