// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import { shellQuote } from "../../core/shell-quote";
import { sleepMs } from "../../core/wait";
import {
  type HermesForwardWatcherCommandLine,
  type HermesForwardWatcherState,
  isManagedHermesForwardWatcherProcess,
} from "../../domain/uninstall/hermes-forward-watcher";
import { readHermesForwardWatcherState } from "../../state/hermes-forward-watcher";

export type { HermesForwardWatcherState };

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

function spawnSyncRun(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): RunResult {
  const result = spawnSync(command, args, { encoding: "utf-8", ...options });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function spawnSyncKill(pid: number, signal?: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function spawnSyncCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  // `command` is always an internal literal ("openshell"), never user input.
  // Single-quoted via shellQuote (not JSON.stringify's double quotes, which do
  // not suppress `$`/backtick/`\` expansion inside `sh -c`) so this carries no
  // injection surface even if that ever changed.
  return (
    spawnSyncRun("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { env })
      .status === 0
  );
}

/**
 * Real-process host for the watcher identity, signal, and forward-stop calls
 * above. Callers that already own an injectable runtime (uninstall) keep
 * passing their own; onboarding and destroy use this one.
 */
export function defaultHermesForwardWatcherHost(
  overrides: Partial<HermesForwardWatcherHost> = {},
): HermesForwardWatcherHost {
  const env = overrides.env ?? process.env;
  return {
    commandExists: overrides.commandExists ?? ((command) => spawnSyncCommandExists(command, env)),
    env,
    kill: overrides.kill ?? spawnSyncKill,
    log: overrides.log ?? ((message) => console.log(`  ${message}`)),
    readProcessArgv: overrides.readProcessArgv,
    run: overrides.run ?? spawnSyncRun,
    warn: overrides.warn ?? ((message) => console.warn(`  ! ${message}`)),
  };
}

/** Watcher selector. Omit `port` to select every port the sandbox planted one for. */
export interface HermesForwardWatcherTarget {
  port?: number | string;
  sandbox: string;
}

/**
 * Managed watchers recorded for `target` whose live process still satisfies the
 * same identity contract `nemoclaw uninstall` requires before it signals
 * anything: the recorded PID exists, runs as the current user, and its exact
 * argv is this watcher's own `node <pidFile>.js <openshell> <port> <sandbox>`.
 *
 * `stateDir` is the final directory holding the `.forward.pid` files (i.e.
 * `resolveNemoclawStateDir()`'s output) and is a caller-supplied path rather
 * than resolved from `$HOME` here, so this stays test-isolated the same way
 * `resolveNemoclawStateDir()`'s other callers already are: a caller that
 * forgets to route through it reads an empty/wrong directory instead of this
 * function silently reading (and, through the signal path below, potentially
 * killing a process under) the invoking user's real `~/.nemoclaw/state` during
 * a test run.
 */
export function findManagedHermesForwardWatchers(
  stateDir: string,
  target: HermesForwardWatcherTarget,
  host: HermesForwardWatcherHost,
): HermesForwardWatcherState[] {
  const state = readHermesForwardWatcherState(stateDir);
  if (!state.readable) {
    host.warn(`Failed to inspect Hermes forward watcher state under ${stateDir}.`);
    return [];
  }
  return state.watchers.filter(
    (watcher) =>
      watcher.sandbox === target.sandbox &&
      (target.port === undefined || watcher.port === String(target.port)) &&
      managedWatcherProcessStatus(watcher, host) === "managed",
  );
}

/**
 * Stop every live managed watcher for `target` and report the ones that
 * stopped. Best effort: the signal path re-checks identity itself and leaves
 * any process it cannot prove is NemoClaw's own watcher untouched.
 */
export function reapManagedHermesForwardWatchers(
  stateDir: string,
  target: HermesForwardWatcherTarget,
  host: HermesForwardWatcherHost,
): HermesForwardWatcherState[] {
  return findManagedHermesForwardWatchers(stateDir, target, host).filter((watcher) =>
    stopHermesForwardWatcherProcess(watcher, host),
  );
}

/** Render watchers as `pid <n> (<script>)` for an operator-facing diagnostic. */
export function describeManagedHermesForwardWatchers(
  watchers: readonly HermesForwardWatcherState[],
): string {
  return watchers
    .map((watcher) => `pid ${String(watcher.pid)} (${watcher.watcherScript})`)
    .join(", ");
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
