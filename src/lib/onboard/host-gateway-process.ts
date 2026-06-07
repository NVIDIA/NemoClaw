// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepMs } from "../core/wait";
import { clearDockerDriverGatewayRuntimeMarker } from "./docker-driver-gateway-runtime-marker";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface HostGatewayProcessDeps {
  run: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  env: NodeJS.ProcessEnv;
  commandExists?: (command: string) => boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface StopHostGatewayOptions {
  gatewayBin?: string | null;
  killWaitMs?: number;
  logNoProcesses?: boolean;
  pids?: Iterable<number>;
  pidFile?: string;
  pollIntervalMs?: number;
  stateDir?: string;
  termWaitMs?: number;
  usePgrepFallback?: boolean;
}

export interface StopHostGatewayResult {
  failed: number[];
  skippedDeadPids: number[];
  skippedNonMatchingPids: number[];
  stopped: number[];
  sudoRemediationPids: number[];
}

const HOST_GATEWAY_PROCESS_NAMES = new Set(["openshell-gateway", "openclaw-gateway"]);
// Container runtimes that can host the compatibility gateway. Limited to the
// ones `docker-driver-gateway-launch` actually invokes so a random user
// command (e.g. `vim /opt/nemoclaw/openshell-gateway`) is never mistaken for
// the parent process of a compat-mode gateway.
const DOCKER_DRIVER_GATEWAY_CONTAINER_RUNTIME_NAMES = new Set(["docker"]);
// Mount path used by docker-driver-gateway-launch when glibc compat forces the
// gateway to run inside a Docker compatibility container. The parent PID we
// record is the host-side `docker run` process whose argv0 is `docker`, so we
// also accept cmdlines whose argv0 is a known container runtime AND that
// include this mount path as a distinct argv token.
const DOCKER_DRIVER_GATEWAY_MOUNT_PATH = "/opt/nemoclaw/openshell-gateway";
// pgrep regex anchors on the original openshell-gateway launch shapes. We do
// not extend it to also match the Docker compat parent because pgrep -f only
// sees the cmdline string, not argv0; without an argv0 gate the compat mount
// path could match unrelated commands. The compat parent is rediscovered via
// the PID file written at launch time.
/** Anchored pgrep pattern for direct host openshell-gateway processes. */
export const HOST_GATEWAY_PGREP_PATTERN = "^(/[^ ]*/)?openshell-gateway( |$)";
const DEFAULT_TERM_WAIT_MS = 1000;
const DEFAULT_KILL_WAIT_MS = 1000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function toRunResult(result: ReturnType<typeof spawnSync>): RunResult {
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
  return (
    defaultRun("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
      env,
    }).status === 0
  );
}

export function resolveDockerDriverGatewayStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = env.HOME || os.homedir(),
): string {
  const configured = env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
}

export function resolveDockerDriverGatewayPidFile(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = env.HOME || os.homedir(),
): string {
  return path.join(resolveDockerDriverGatewayStateDir(env, homeDir), "openshell-gateway.pid");
}

function defaultDeps(overrides: Partial<HostGatewayProcessDeps> = {}): HostGatewayProcessDeps {
  const env = overrides.env ?? process.env;
  return {
    run: overrides.run ?? defaultRun,
    kill: overrides.kill ?? defaultKill,
    env,
    commandExists: overrides.commandExists ?? ((cmd) => defaultCommandExists(cmd, env)),
    log: overrides.log,
    warn: overrides.warn,
  };
}

function parsePidLines(output: string): number[] {
  return output
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function readPidFile(pidFile: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readProcCmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function processArgs(pid: number, deps: HostGatewayProcessDeps): string {
  const procArgs = readProcCmdline(pid);
  if (procArgs) return procArgs;
  const result = deps.run("ps", ["-p", String(pid), "-o", "args="], { env: deps.env });
  return result.status === 0 ? result.stdout.trim() : "";
}

function pidExists(pid: number, deps: HostGatewayProcessDeps): boolean {
  return deps.run("ps", ["-p", String(pid), "-o", "pid="], { env: deps.env }).status === 0;
}

function pidOwner(pid: number, deps: HostGatewayProcessDeps): string | null {
  const result = deps.run("ps", ["-p", String(pid), "-o", "user="], { env: deps.env });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function hostGatewayCmdlineMatches(
  cmdline: string,
  gatewayBin: string | null | undefined,
): boolean {
  const tokens = cmdline.trim().split(/\s+/);
  const argv0 = tokens[0] ?? "";
  if (!argv0) return false;
  const base = path.basename(argv0);
  if (HOST_GATEWAY_PROCESS_NAMES.has(base)) return true;
  if (
    typeof gatewayBin === "string" &&
    gatewayBin.length > 0 &&
    path.resolve(argv0) === path.resolve(gatewayBin)
  ) {
    return true;
  }
  // Docker compatibility mode: argv0 basename must be a known container
  // runtime AND the mount path appears as a separate argv token. Substring
  // matching inside random tokens (e.g. a log message or `vim
  // /opt/nemoclaw/openshell-gateway`) would over-match, so require both.
  if (
    DOCKER_DRIVER_GATEWAY_CONTAINER_RUNTIME_NAMES.has(base) &&
    tokens.includes(DOCKER_DRIVER_GATEWAY_MOUNT_PATH)
  ) {
    return true;
  }
  return false;
}

function waitForExit(
  pid: number,
  deps: HostGatewayProcessDeps,
  timeoutMs: number,
  pollIntervalMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid, deps)) return true;
    sleepMs(pollIntervalMs);
  }
  return !pidExists(pid, deps);
}

function clearRuntimeFiles(pidFile: string, stateDir: string): void {
  fs.rmSync(pidFile, { force: true });
  clearDockerDriverGatewayRuntimeMarker(stateDir);
}

function addPid(candidates: Map<number, Set<string>>, pid: number, source: string): void {
  const sources = candidates.get(pid) ?? new Set<string>();
  sources.add(source);
  candidates.set(pid, sources);
}

function pgrepHostGatewayPids(deps: HostGatewayProcessDeps): {
  pids: number[];
  scanned: boolean;
} {
  if (deps.commandExists && !deps.commandExists("pgrep")) {
    return { pids: [], scanned: false };
  }
  const result = deps.run("pgrep", ["-f", HOST_GATEWAY_PGREP_PATTERN], { env: deps.env });
  if (result.status !== 0 && result.status !== 1) {
    const warn = deps.warn ?? ((message: string) => console.warn(message));
    const detail = result.stderr.trim() || `status ${String(result.status)}`;
    warn(`pgrep failed while scanning host openshell-gateway processes: ${detail}`);
    return { pids: [], scanned: false };
  }
  return { pids: parsePidLines(result.stdout), scanned: true };
}

function warnSudoRemediation(pid: number, deps: HostGatewayProcessDeps): void {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const owner = pidOwner(pid, deps);
  const ownerLabel = owner ? `${owner}-owned` : "privileged";
  warn(
    `Cannot stop ${ownerLabel} host openshell-gateway process ${pid}. ` +
      "Run: sudo pkill -f openshell-gateway",
  );
}

function tryStopPid(
  pid: number,
  deps: HostGatewayProcessDeps,
  options: Required<Pick<StopHostGatewayOptions, "killWaitMs" | "pollIntervalMs" | "termWaitMs">>,
): "stopped" | "failed" {
  const log = deps.log ?? ((message: string) => console.log(message));
  deps.kill(pid, "SIGTERM");
  if (waitForExit(pid, deps, options.termWaitMs, options.pollIntervalMs)) {
    log(`Stopped host openshell-gateway process ${pid}`);
    return "stopped";
  }
  deps.kill(pid, "SIGKILL");
  if (waitForExit(pid, deps, options.killWaitMs, options.pollIntervalMs)) {
    log(`Stopped host openshell-gateway process ${pid} (after SIGKILL)`);
    return "stopped";
  }
  warnSudoRemediation(pid, deps);
  return "failed";
}

export function stopHostGatewayProcesses(
  depsOverrides: Partial<HostGatewayProcessDeps> = {},
  options: StopHostGatewayOptions = {},
): StopHostGatewayResult {
  const deps = defaultDeps(depsOverrides);
  const stateDir = options.stateDir ?? resolveDockerDriverGatewayStateDir(deps.env);
  const pidFile = options.pidFile ?? path.join(stateDir, "openshell-gateway.pid");
  const candidates = new Map<number, Set<string>>();
  const result: StopHostGatewayResult = {
    failed: [],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    stopped: [],
    sudoRemediationPids: [],
  };

  const pidFromFile = readPidFile(pidFile);
  if (pidFromFile !== null) {
    addPid(candidates, pidFromFile, "pid-file");
  } else if (fs.existsSync(pidFile)) {
    clearRuntimeFiles(pidFile, stateDir);
  }

  const explicitPids = Array.from(options.pids ?? []).filter(
    (pid): pid is number => Number.isInteger(pid) && pid > 0,
  );
  for (const pid of explicitPids) addPid(candidates, pid, "explicit");

  // When a caller passes explicit PIDs (e.g. drift-restart targeting one
  // gateway), default to NOT sweeping every matching openshell-gateway on the
  // host. Otherwise an onboard drift could terminate an unrelated worktree's
  // gateway. Sweeping callers (uninstall, sandbox destroy of the last sandbox)
  // omit `pids` and so still get the pgrep fallback by default.
  const useFallback =
    options.usePgrepFallback ?? explicitPids.length === 0;
  let pgrepRan = false;
  if (useFallback) {
    const sweep = pgrepHostGatewayPids(deps);
    pgrepRan = sweep.scanned;
    for (const pid of sweep.pids) addPid(candidates, pid, "pgrep");
  }

  const waitOptions = {
    killWaitMs: options.killWaitMs ?? DEFAULT_KILL_WAIT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    termWaitMs: options.termWaitMs ?? DEFAULT_TERM_WAIT_MS,
  };
  let clearedRuntimeFiles = false;
  for (const [pid, sources] of candidates) {
    if (!pidExists(pid, deps)) {
      result.skippedDeadPids.push(pid);
      if (sources.has("pid-file") && !clearedRuntimeFiles) {
        clearRuntimeFiles(pidFile, stateDir);
        clearedRuntimeFiles = true;
      }
      continue;
    }
    if (!hostGatewayCmdlineMatches(processArgs(pid, deps), options.gatewayBin)) {
      result.skippedNonMatchingPids.push(pid);
      if (sources.has("pid-file") && !clearedRuntimeFiles) {
        clearRuntimeFiles(pidFile, stateDir);
        clearedRuntimeFiles = true;
      }
      continue;
    }

    if (tryStopPid(pid, deps, waitOptions) === "stopped") {
      result.stopped.push(pid);
      if (!clearedRuntimeFiles) {
        clearRuntimeFiles(pidFile, stateDir);
        clearedRuntimeFiles = true;
      }
    } else {
      result.failed.push(pid);
      result.sudoRemediationPids.push(pid);
    }
  }

  if (options.logNoProcesses && candidates.size === 0) {
    if (useFallback && !pgrepRan) {
      // The pid-file branch found nothing and the pgrep fallback could not
      // run (typically `pgrep` is absent on a minimal image). Surface the
      // skip so an uninstaller doesn't claim success while an orphan host
      // gateway is still bound.
      const warn = deps.warn ?? ((message: string) => console.warn(message));
      warn(
        "pgrep not found; could not scan for orphan host openshell-gateway processes. " +
          "If port 8080 is still bound, run: sudo pkill -f openshell-gateway",
      );
    } else {
      const log = deps.log ?? ((message: string) => console.log(message));
      log("No host openshell-gateway processes found");
    }
  }

  return result;
}
