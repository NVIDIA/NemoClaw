// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stale host-side gateway-forward cleanup.
 *
 * Background: when `openshell forward start` is killed unexpectedly (failed
 * onboard, container crash mid-build, upgrade across versions), the host-side
 * process that holds the NemoClaw dashboard port can survive. It commonly
 * shows up in `ss -tlnp` as `openclaw-gatewa(y)` because the forward shim
 * re-execs into the binary it proxies for. The next `nemoclaw onboard`
 * detects the port conflict and falls back to a different port, but the new
 * sandbox is baked with the original port and never becomes reachable. See
 * #3397 and #3398.
 *
 * This module finds those orphans by scanning the dashboard port range,
 * verifying ownership and cmdline, then sending SIGTERM followed by SIGKILL
 * with bounded waits — mirroring the proven `tryStopOllamaProxyPid` pattern
 * in `src/lib/actions/uninstall/run-plan.ts`.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import os from "node:os";

import { DASHBOARD_PORT_RANGE_END, DASHBOARD_PORT_RANGE_START } from "../core/ports";
import { sleepMs } from "../core/wait";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface StaleGatewayDeps {
  /** Spawn a command synchronously. Mirrors `child_process.spawnSync` shape. */
  run: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  /** Send a signal to a PID. Returns true if the signal was accepted. */
  kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  /** Environment used for resolving the expected process owner. */
  env: NodeJS.ProcessEnv;
  /** Informational log sink (used for successful stops). Defaults to console.log. */
  log?: (message: string) => void;
  /** Warning sink for partial failures. Defaults to console.warn. */
  warn?: (message: string) => void;
  /** Returns true if the named CLI exists on PATH. Defaults to a `command -v` probe. */
  commandExists?: (command: string) => boolean;
}

export interface CleanupResult {
  stopped: number[];
  skippedForeignPids: number[];
  skippedNonMatchingPids: number[];
  skippedProtectedPorts: number[];
}

export interface SandboxDashboardPortEntry {
  name: string;
  dashboardPort?: number | null;
}

export interface StaleGatewayOptions {
  /**
   * Ports that must not be swept even if a matching gateway-forward process is
   * holding them. The onboard `--fresh` path passes the dashboard ports of
   * currently-registered sandboxes so a fresh onboard for a new name does not
   * disrupt the forward of an existing sandbox (#3260).
   */
  protectedPorts?: Iterable<number>;
}

const CMDLINE_MARKERS = ["openclaw-gateway", "openshell-forward", "openshell forward"];

const TERM_WAIT_MS = 1000;
const KILL_WAIT_MS = 1000;

function toRunResult(
  result: ReturnType<typeof spawnSync>,
): RunResult {
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function defaultRun(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): RunResult {
  return toRunResult(spawnSync(command, args, { encoding: "utf-8", ...options }));
}

function defaultKill(pid: number, signal?: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const probe = spawnSync(
    "sh",
    ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`],
    { env, encoding: "utf-8" },
  );
  return probe.status === 0;
}

export function defaultStaleGatewayDeps(
  overrides: Partial<StaleGatewayDeps> = {},
): StaleGatewayDeps {
  const env = overrides.env ?? process.env;
  return {
    run: overrides.run ?? defaultRun,
    kill: overrides.kill ?? defaultKill,
    env,
    log: overrides.log,
    warn: overrides.warn,
    commandExists: overrides.commandExists ?? ((cmd) => defaultCommandExists(cmd, env)),
  };
}

function parsePidLines(output: string): number[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
}

function pidOwnedByCurrentUser(pid: number, deps: StaleGatewayDeps): boolean {
  const expected =
    deps.env.SUDO_USER || deps.env.LOGNAME || deps.env.USER || os.userInfo().username;
  if (!expected) return false;
  const result = deps.run("ps", ["-p", String(pid), "-o", "user="], { env: deps.env });
  return result.status === 0 && result.stdout.trim() === expected;
}

function pidExists(pid: number, deps: StaleGatewayDeps): boolean {
  return (
    deps.run("ps", ["-p", String(pid), "-o", "pid="], { env: deps.env }).status === 0
  );
}

function waitForExit(pid: number, deps: StaleGatewayDeps, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid, deps)) return true;
    sleepMs(50);
  }
  return !pidExists(pid, deps);
}

function pidCmdlineMatches(pid: number, deps: StaleGatewayDeps): boolean {
  const result = deps.run("ps", ["-p", String(pid), "-o", "args="], { env: deps.env });
  if (result.status !== 0) return false;
  const cmdline = result.stdout.trim();
  return CMDLINE_MARKERS.some((marker) => cmdline.includes(marker));
}

function lsofPidsForPort(port: number, deps: StaleGatewayDeps): number[] {
  // Restrict to listening sockets so we never kill a process that is only
  // an in-flight client of the port (matches the `-sTCP:LISTEN` pattern in
  // preflight). Anything else under SIGTERM/SIGKILL would be unsafe.
  const result = deps.run("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { env: deps.env });
  if (result.status !== 0 && result.status !== 1) {
    // Status 1 from lsof is "no listeners" — normal. Anything else is a real error.
    const warn = deps.warn ?? ((m: string) => console.warn(m));
    const detail = result.stderr.trim() || `status ${String(result.status)}`;
    warn(`lsof failed while scanning dashboard port ${port}: ${detail}`);
    return [];
  }
  return parsePidLines(result.stdout);
}

export function getProtectedDashboardPortsForSandbox(
  sandboxes: Iterable<SandboxDashboardPortEntry>,
  sandboxName: string,
): number[] {
  return Array.from(sandboxes)
    .filter((sb) => sb.name !== sandboxName)
    .map((sb) => sb.dashboardPort)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));
}

export function stopStaleDashboardListenersForSandbox(
  sandboxes: Iterable<SandboxDashboardPortEntry>,
  sandboxName: string,
  depsOverrides: Partial<StaleGatewayDeps> = {},
): CleanupResult {
  return stopStaleDashboardListeners(depsOverrides, {
    protectedPorts: getProtectedDashboardPortsForSandbox(sandboxes, sandboxName),
  });
}

function tryStopPid(pid: number, deps: StaleGatewayDeps): boolean {
  const log = deps.log ?? ((m) => console.log(m));
  const warn = deps.warn ?? ((m) => console.warn(m));

  deps.kill(pid, "SIGTERM");
  if (waitForExit(pid, deps, TERM_WAIT_MS)) {
    log(`Stopped stale dashboard gateway listener ${pid}`);
    return true;
  }
  deps.kill(pid, "SIGKILL");
  if (waitForExit(pid, deps, KILL_WAIT_MS)) {
    log(`Stopped stale dashboard gateway listener ${pid} (after SIGKILL)`);
    return true;
  }
  warn(`Failed to stop stale dashboard gateway listener ${pid}`);
  return false;
}

/**
 * Scan the dashboard port range for stale host-side gateway-forward processes
 * left over from a previous `nemoclaw onboard` / `openshell forward start` and
 * stop them. Safe to call repeatedly — if no orphans are found the function
 * exits cleanly.
 *
 * Conservative by design:
 *   - Only PIDs the current user can signal are considered.
 *   - Only PIDs whose cmdline matches one of [[CMDLINE_MARKERS]] are killed.
 *   - Two-phase TERM-then-KILL with bounded waits prevents zombie kills.
 *
 * When `lsof` is unavailable the scan returns without warning — the caller
 * shouldn't block uninstall/destroy on missing tooling. Other unexpected
 * states are surfaced through `deps.warn`.
 */
export function stopStaleDashboardListeners(
  depsOverrides: Partial<StaleGatewayDeps> = {},
  options: StaleGatewayOptions = {},
): CleanupResult {
  const deps = defaultStaleGatewayDeps(depsOverrides);
  const protectedPorts = new Set<number>(
    options.protectedPorts ? Array.from(options.protectedPorts).filter(Number.isFinite) : [],
  );
  const result: CleanupResult = {
    stopped: [],
    skippedForeignPids: [],
    skippedNonMatchingPids: [],
    skippedProtectedPorts: [],
  };
  if (deps.commandExists && !deps.commandExists("lsof")) return result;

  const seen = new Set<number>();
  for (let port = DASHBOARD_PORT_RANGE_START; port <= DASHBOARD_PORT_RANGE_END; port += 1) {
    if (protectedPorts.has(port)) {
      const pids = lsofPidsForPort(port, deps);
      if (pids.length > 0) {
        result.skippedProtectedPorts.push(port);
        for (const pid of pids) seen.add(pid);
      }
      continue;
    }
    for (const pid of lsofPidsForPort(port, deps)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (!pidOwnedByCurrentUser(pid, deps)) {
        result.skippedForeignPids.push(pid);
        continue;
      }
      if (!pidCmdlineMatches(pid, deps)) {
        result.skippedNonMatchingPids.push(pid);
        continue;
      }
      if (tryStopPid(pid, deps)) result.stopped.push(pid);
    }
  }
  return result;
}
