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

type ManagedWatcherProcessStatus = "absent" | "managed" | "other" | "unknown";

function pidExists(pid: number, host: HermesForwardWatcherHost): boolean | null {
  const result = host.run("ps", ["-p", String(pid), "-o", "pid="], { env: host.env });
  if (result.status === 0) return result.stdout.trim() ? true : null;
  return result.status === 1 ? false : null;
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

function processUser(pid: number, host: HermesForwardWatcherHost): string | null {
  const result = host.run("ps", ["-p", String(pid), "-o", "user="], { env: host.env });
  const user = result.status === 0 ? result.stdout.trim() : "";
  return user || null;
}

function managedWatcherProcessStatus(
  watcher: HermesForwardWatcherState,
  host: HermesForwardWatcherHost,
): ManagedWatcherProcessStatus {
  const pid = watcher.pid;
  if (pid === null) return "unknown";
  const exists = pidExists(pid, host);
  if (exists === false) return "absent";
  if (exists === null) return "unknown";

  const commandLine = readProcessCommandLine(pid, host);
  const observedUser = processUser(pid, host);
  if (!commandLine || observedUser === null) {
    const stillExists = pidExists(pid, host);
    return stillExists === false ? "absent" : "unknown";
  }
  return isManagedHermesForwardWatcherProcess({
    commandLine,
    expectedUser: currentUser(host),
    observedUser,
    watcher,
  })
    ? "managed"
    : "other";
}

function waitForWatcherExit(
  watcher: HermesForwardWatcherState,
  host: HermesForwardWatcherHost,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = managedWatcherProcessStatus(watcher, host);
    if (status === "absent" || status === "other") return true;
    sleepMs(50);
  }
  const status = managedWatcherProcessStatus(watcher, host);
  return status === "absent" || status === "other";
}

export function stopHermesForwardWatcherProcess(
  watcher: HermesForwardWatcherState,
  host: HermesForwardWatcherHost,
): boolean {
  const pid = watcher.pid;
  if (pid === null) {
    host.warn(`Failed to read a valid Hermes forward watcher PID from ${watcher.pidFile}.`);
    return false;
  }
  const initialStatus = managedWatcherProcessStatus(watcher, host);
  if (initialStatus === "absent" || initialStatus === "other") return true;
  if (initialStatus === "unknown") {
    host.warn(`Failed to inspect Hermes forward watcher ${pid}; preserving state for retry.`);
    return false;
  }

  host.kill(pid);
  if (waitForWatcherExit(watcher, host, 1000)) {
    host.log(`Stopped Hermes forward watcher ${pid}`);
    return true;
  }
  const beforeForceKill = managedWatcherProcessStatus(watcher, host);
  if (beforeForceKill === "absent" || beforeForceKill === "other") {
    host.log(`Stopped Hermes forward watcher ${pid}`);
    return true;
  }
  if (beforeForceKill === "unknown") {
    host.warn(
      `Failed to confirm Hermes forward watcher ${pid} identity; preserving state for retry.`,
    );
    return false;
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
