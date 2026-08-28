// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { waitUntil } from "../core/wait";
import { DEFAULT_GATEWAY_PORT, resolveGatewayStateDirForPort } from "./gateway/state-dir";
import {
  gatewayIdForStateDir,
  hasStateScopedSandboxNamespace,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "./docker-driver-gateway-config";
import {
  clearDockerDriverGatewayRuntimeMarker,
  getDockerDriverGatewayRuntimeMarkerPath,
  parseDockerDriverGatewayRuntimeMarker,
} from "./docker-driver-gateway-runtime-marker";
import {
  canonicalGatewayTargetMatches,
  type OpenShellGatewayProcessTarget,
  hostGatewayCmdlineMatches as sharedHostGatewayCmdlineMatches,
} from "./gateway-process-identity";

export { hasStateScopedSandboxNamespace } from "./docker-driver-gateway-config";

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
  isPortFree?: (port: number) => boolean;
  log?: (message: string) => void;
  readProcessExecutable?: (pid: number) => string | null;
  readProcessEnvironment?: (pid: number) => Record<string, string> | null;
  warn?: (message: string) => void;
}

export interface StopHostGatewayOptions {
  /** Whether successful stops may clear the pid file/runtime marker. */
  clearRuntimeFiles?: boolean;
  gatewayBin?: string | null;
  killWaitMs?: number;
  logNoProcesses?: boolean;
  openShellGatewayName?: string;
  openShellGatewayPort?: number | string;
  pids?: Iterable<number>;
  pidFile?: string;
  pollIntervalMs?: number;
  /** Keep PID/runtime evidence when a PID-file process does not match the cleanup target. */
  preserveRuntimeFilesOnNonMatching?: boolean;
  /** Restrict cleanup to one fully proven PID-file gateway. */
  scopedGatewayStop?: boolean;
  stateDir?: string;
  termWaitMs?: number;
  /** Whether to read and act on the resolved pid file. */
  usePidFile?: boolean;
  usePgrepFallback?: boolean;
}

export interface StopHostGatewayResult {
  failed: number[];
  foreignUserPids?: number[];
  /** Whether a requested pgrep fallback completed with a usable result. */
  orphanScanComplete?: boolean;
  ownershipFailures?: string[];
  skippedDeadPids: number[];
  skippedNonMatchingPids: number[];
  stopped: number[];
  sudoRemediationPids: number[];
}

// pgrep regex anchors on the original openshell-gateway launch shapes. We do
// not extend it to also match the Docker compat parent because pgrep -f only
// sees the cmdline string, not argv0; without an argv0 gate the compat mount
// path could match unrelated commands. The compat parent is rediscovered via
// the PID file written at launch time.
/** Anchored pgrep pattern for direct host openshell-gateway processes. */
export const HOST_GATEWAY_PGREP_PATTERN =
  "^(/[^ ]*/)?openshell-gateway(\\[nemoclaw=nemoclaw(-[0-9]+)?;port=[0-9]+\\]| |$)";
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

function defaultRun(command: string, args: string[], options: SpawnSyncOptions = {}): RunResult {
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
  // `command` is always an internal, trusted literal ("pgrep"); it is never
  // user-supplied. It is also JSON.stringify-quoted, so the `sh -c` here carries
  // no shell-injection surface.
  return (
    defaultRun("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
      env,
    }).status === 0
  );
}

export function resolveDockerDriverGatewayStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = env.HOME || os.homedir(),
  gatewayPort: number = DEFAULT_GATEWAY_PORT,
): string {
  return resolveGatewayStateDirForPort({
    configured: env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    home: homeDir,
    port: gatewayPort,
  });
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
    isPortFree: overrides.isPortFree ?? ((port) => isHostPortFree(port)),
    log: overrides.log,
    readProcessExecutable: overrides.readProcessExecutable,
    readProcessEnvironment: overrides.readProcessEnvironment,
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

type HostGatewayProcessStatus = "exited" | "running" | "unknown";
const EXITED_PROCESS_STATES = new Set(["X", "Z", "x"]);
const RUNNING_PROCESS_STATES = new Set(["D", "I", "K", "P", "R", "S", "T", "U", "W", "t"]);

function hostGatewayProcessStatus(
  pid: number,
  deps: HostGatewayProcessDeps,
): HostGatewayProcessStatus {
  const result = deps.run("ps", ["-p", String(pid), "-o", "stat="], { env: deps.env });
  if (result.status === 1) {
    return result.stdout.trim() === "" && result.stderr.trim() === "" ? "exited" : "unknown";
  }
  if (result.status !== 0) return "unknown";
  const state = result.stdout.trim().charAt(0);
  if (EXITED_PROCESS_STATES.has(state)) return "exited";
  return RUNNING_PROCESS_STATES.has(state) ? "running" : "unknown";
}

function pidOwner(pid: number, deps: HostGatewayProcessDeps): string | null {
  const result = deps.run("ps", ["-p", String(pid), "-o", "user="], { env: deps.env });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function pidOwnerUid(pid: number, deps: HostGatewayProcessDeps): number | null {
  const result = deps.run("ps", ["-p", String(pid), "-o", "uid="], { env: deps.env });
  if (result.status !== 0) return null;
  const uid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(uid) ? uid : null;
}

function pidBelongsToAnotherUser(pid: number, deps: HostGatewayProcessDeps): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (currentUid < 0) return false;
  const uid = pidOwnerUid(pid, deps);
  if (uid === null || uid === 0) return false;
  return uid !== currentUid;
}

function warnForeignUserGateway(pid: number, deps: HostGatewayProcessDeps): void {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const owner = pidOwner(pid, deps);
  const ownerLabel = owner ? `${owner}-owned` : "another user's";
  warn(
    `Kept ${ownerLabel} host openshell-gateway process ${pid} running. ` +
      "Cleanup does not stop a gateway process that another user owns.",
  );
}

function readOwnedRuntimeFile(filePath: string, uid: number): string | null {
  if (typeof fs.constants.O_NOFOLLOW !== "number") return null;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.size > 64 * 1024)
      return null;
    return fs.readFileSync(descriptor, "utf-8");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function processUsesStateScopedSandboxNamespace(
  pid: number,
  stateDir: string,
  deps: Pick<HostGatewayProcessDeps, "env" | "readProcessEnvironment" | "run">,
): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const owner = deps.run("ps", ["-p", String(pid), "-o", "uid="], { env: deps.env });
  if (owner.status !== 0 || Number(owner.stdout.trim()) !== uid) return false;
  let environment = deps.readProcessEnvironment?.(pid) ?? null;
  if (!environment) {
    try {
      environment = Object.fromEntries(
        fs
          .readFileSync(`/proc/${String(pid)}/environ`, "utf-8")
          .split("\0")
          .filter(Boolean)
          .map((entry) => [
            entry.slice(0, entry.indexOf("=")),
            entry.slice(entry.indexOf("=") + 1),
          ]),
      );
    } catch {
      const command = deps.run("ps", ["eww", "-p", String(pid), "-o", "command="], {
        env: deps.env,
      });
      const prefix = `${NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV}=`;
      const value = command.stdout.split(/\s+/).find((token) => token.startsWith(prefix));
      environment = value
        ? { [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: value.slice(prefix.length) }
        : null;
    }
  }
  return environment?.[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV] === gatewayIdForStateDir(stateDir);
}

function readProcessExecutable(pid: number, deps: HostGatewayProcessDeps): string | null {
  if (deps.readProcessExecutable) return deps.readProcessExecutable(pid);
  try {
    return fs.realpathSync.native(`/proc/${String(pid)}/exe`);
  } catch {
    return null;
  }
}

function normalizeProcessExecutable(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

export function externallySupervisedHostGatewayProcessOwnershipFailure(
  depsOverrides: Partial<HostGatewayProcessDeps>,
  options: {
    gatewayBin: string;
    gatewayName: string;
    gatewayPort: number;
    pid: number;
    stateDir: string;
  },
): string | null {
  const deps = defaultDeps(depsOverrides);
  if (!canonicalGatewayTargetMatches(options.gatewayName, options.gatewayPort)) {
    return "selected gateway name and port are not canonical";
  }
  if (!processUsesStateScopedSandboxNamespace(options.pid, options.stateDir, deps)) {
    return "gateway process owner and loaded sandbox namespace cannot be proven";
  }
  const executable = readProcessExecutable(options.pid, deps);
  if (
    !executable ||
    normalizeProcessExecutable(executable) !== normalizeProcessExecutable(options.gatewayBin)
  ) {
    return "process executable does not match the declared supervisor executable";
  }
  if (
    !hostGatewayCmdlineMatches(
      processArgs(options.pid, deps),
      options.gatewayBin,
      { name: options.gatewayName, port: options.gatewayPort },
      { requireExpectedFlags: true },
    )
  ) {
    return "process command line does not identify the selected gateway name and port";
  }
  return null;
}

export function hostGatewayCmdlineMatches(
  cmdline: string,
  gatewayBin: string | null | undefined,
  expectedOpenShellGateway?: OpenShellGatewayProcessTarget,
  opts: { requireExpectedFlags?: boolean } = {},
): boolean {
  return sharedHostGatewayCmdlineMatches(cmdline, gatewayBin, expectedOpenShellGateway, opts);
}

function scopedGatewayOwnershipFailure(
  pid: number,
  deps: HostGatewayProcessDeps,
  options: StopHostGatewayOptions,
  stateDir: string,
  pidFile: string,
  target: { name: string; port: number },
): string | null {
  if (!hasStateScopedSandboxNamespace(stateDir)) {
    return "gateway config does not prove an isolated sandbox namespace";
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const pidText = readOwnedRuntimeFile(pidFile, uid);
  const markerText = readOwnedRuntimeFile(getDockerDriverGatewayRuntimeMarkerPath(stateDir), uid);
  const marker = markerText ? parseDockerDriverGatewayRuntimeMarker(markerText) : null;
  if (Number(pidText?.trim()) !== pid || marker?.pid !== pid) {
    return "PID file and runtime marker do not identify the same process";
  }
  let markerPort = 0;
  try {
    markerPort = Number(new URL(marker.endpoint).port);
  } catch {
    return "runtime marker endpoint is invalid";
  }
  if (
    markerPort !== target.port ||
    marker.platform !== process.platform ||
    marker.arch !== process.arch
  ) {
    return "runtime marker does not identify the selected gateway";
  }
  if (!processUsesStateScopedSandboxNamespace(pid, stateDir, deps)) {
    return "gateway process owner and loaded sandbox namespace cannot be proven";
  }
  if (
    !hostGatewayCmdlineMatches(processArgs(pid, deps), options.gatewayBin, target, {
      requireExpectedFlags: true,
    })
  ) {
    return "process command line does not identify the selected gateway name and port";
  }
  return null;
}

export function scopedHostGatewayProcessOwnershipFailure(
  depsOverrides: Partial<HostGatewayProcessDeps>,
  options: Pick<
    StopHostGatewayOptions,
    "gatewayBin" | "openShellGatewayName" | "openShellGatewayPort" | "pidFile" | "stateDir"
  >,
): string | null {
  const deps = defaultDeps(depsOverrides);
  const stateDir = options.stateDir ?? resolveDockerDriverGatewayStateDir(deps.env);
  const pidFile = options.pidFile ?? path.join(stateDir, "openshell-gateway.pid");
  const port = Number(options.openShellGatewayPort);
  const name = options.openShellGatewayName?.trim() ?? "";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !canonicalGatewayTargetMatches(name, port)
  ) {
    return "selected gateway name and port are not canonical";
  }
  const pid = readPidFile(pidFile);
  if (pid === null) return "selected gateway PID file is missing or invalid";
  if (hostGatewayProcessStatus(pid, deps) !== "running") {
    return "selected gateway process is not running with a proven status";
  }
  return scopedGatewayOwnershipFailure(pid, deps, options, stateDir, pidFile, { name, port });
}

/** Prove that neither recorded nor discoverable host gateway processes claim this state root. */
export function scopedHostGatewayProcessAbsenceFailure(
  depsOverrides: Partial<HostGatewayProcessDeps>,
  options: Pick<
    StopHostGatewayOptions,
    "gatewayBin" | "openShellGatewayName" | "openShellGatewayPort" | "pidFile" | "stateDir"
  >,
): string | null {
  const deps = defaultDeps(depsOverrides);
  const stateDir = options.stateDir ?? resolveDockerDriverGatewayStateDir(deps.env);
  const pidFile = options.pidFile ?? path.join(stateDir, "openshell-gateway.pid");
  const port = Number(options.openShellGatewayPort);
  const name = options.openShellGatewayName?.trim() ?? "";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !canonicalGatewayTargetMatches(name, port)
  ) {
    return "selected gateway name and port are not canonical";
  }
  if (deps.isPortFree?.(port) !== true) {
    return "selected gateway port is occupied";
  }
  const recordedPid = readPidFile(pidFile);
  if (recordedPid !== null) {
    const status = hostGatewayProcessStatus(recordedPid, deps);
    if (status === "running") return "the recorded gateway process is still running";
    if (status === "unknown") return "the recorded gateway process status cannot be proven";
  }
  const sweep = pgrepHostGatewayPids(deps);
  if (!sweep.scanned) return "the orphan gateway process scan did not complete";
  for (const pid of sweep.pids) {
    const status = hostGatewayProcessStatus(pid, deps);
    if (status === "unknown") return `gateway process ${String(pid)} status cannot be proven`;
    if (status === "exited") continue;
    if (
      processUsesStateScopedSandboxNamespace(pid, stateDir, deps) ||
      hostGatewayCmdlineMatches(
        processArgs(pid, deps),
        options.gatewayBin,
        { name, port },
        { requireExpectedFlags: true },
      )
    ) {
      return `live gateway process ${String(pid)} claims the selected state directory`;
    }
  }
  if (deps.isPortFree?.(port) !== true) {
    return "selected gateway port became occupied during the process scan";
  }
  return null;
}

function waitForExit(
  pid: number,
  deps: HostGatewayProcessDeps,
  timeoutMs: number,
  pollIntervalMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  return (
    waitUntil(() => hostGatewayProcessStatus(pid, deps) === "exited", {
      deadlineMs: deadline,
      initialIntervalMs: pollIntervalMs,
      maxIntervalMs: pollIntervalMs,
      backoffFactor: 1,
    }) || hostGatewayProcessStatus(pid, deps) === "exited"
  );
}

export function clearHostGatewayRuntimeFiles(stateDir: string, pidFile: string): void {
  clearDockerDriverGatewayRuntimeMarker(stateDir);
  fs.rmSync(pidFile, { force: true });
}

export function isHostPortFree(port: number, spawnSyncImpl: typeof spawnSync = spawnSync): boolean {
  const script =
    "const net = require('node:net');" +
    "const server = net.createServer();" +
    "let done = false;" +
    "const finish = (code) => { if (!done) { done = true; process.exit(code); } };" +
    "server.once('error', () => finish(1));" +
    `server.listen(${String(port)}, '127.0.0.1', () => server.close(() => finish(0)));`;
  try {
    return (
      spawnSyncImpl(process.execPath, ["-e", script], {
        stdio: "ignore",
        timeout: 2_000,
      }).status === 0
    );
  } catch {
    return false;
  }
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

function warnSudoRemediation(
  pid: number,
  deps: HostGatewayProcessDeps,
  expected: {
    name?: string;
    port?: number;
  },
): void {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const owner = pidOwner(pid, deps);
  const ownerLabel = owner ? `${owner}-owned` : "privileged";
  const target =
    expected.name && expected.port
      ? `gateway '${expected.name}' on port ${String(expected.port)}`
      : "the intended gateway name and port";
  warn(
    `Cannot stop ${ownerLabel} host openshell-gateway process ${pid}. ` +
      `Do not signal this saved PID without a fresh identity check. Before any privileged stop, ` +
      `verify that the live process owner and command line identify ${target}, and that the PID ` +
      "file, runtime marker, and loaded sandbox namespace still match the selected state directory.",
  );
}

function tryStopPid(
  pid: number,
  deps: HostGatewayProcessDeps,
  options: Required<Pick<StopHostGatewayOptions, "killWaitMs" | "pollIntervalMs" | "termWaitMs">>,
  canSignal?: () => boolean,
  remediationTarget: { name?: string; port?: number } = {},
): "stopped" | "failed" | "identity-changed" {
  const log = deps.log ?? ((message: string) => console.log(message));
  if (canSignal && !canSignal()) return "identity-changed";
  deps.kill(pid, "SIGTERM");
  if (waitForExit(pid, deps, options.termWaitMs, options.pollIntervalMs)) {
    log(`Stopped host openshell-gateway process ${pid}`);
    return "stopped";
  }
  if (canSignal && !canSignal()) return "identity-changed";
  deps.kill(pid, "SIGKILL");
  if (waitForExit(pid, deps, options.killWaitMs, options.pollIntervalMs)) {
    log(`Stopped host openshell-gateway process ${pid} (after SIGKILL)`);
    return "stopped";
  }
  warnSudoRemediation(pid, deps, remediationTarget);
  return "failed";
}

export function stopHostGatewayProcesses(
  depsOverrides: Partial<HostGatewayProcessDeps> = {},
  options: StopHostGatewayOptions = {},
): StopHostGatewayResult {
  const deps = defaultDeps(depsOverrides);
  const stateDir = options.stateDir ?? resolveDockerDriverGatewayStateDir(deps.env);
  const pidFile = options.pidFile ?? path.join(stateDir, "openshell-gateway.pid");
  const clearRuntimeState = options.clearRuntimeFiles ?? true;
  const candidates = new Map<number, Set<string>>();
  const result: StopHostGatewayResult = {
    failed: [],
    foreignUserPids: [],
    orphanScanComplete: true,
    ownershipFailures: [],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    stopped: [],
    sudoRemediationPids: [],
  };

  const explicitPids = Array.from(options.pids ?? []).filter(
    (pid): pid is number => Number.isInteger(pid) && pid > 0,
  );
  const scopedPort = Number(options.openShellGatewayPort);
  const scopedName = options.openShellGatewayName?.trim() ?? "";
  const rejectScoped = (reason: string, pid?: number): StopHostGatewayResult => {
    if (pid) result.skippedNonMatchingPids.push(pid);
    (result.ownershipFailures ??= []).push(pid ? `PID ${String(pid)}: ${reason}` : reason);
    return result;
  };
  if (
    options.scopedGatewayStop &&
    (!Number.isInteger(scopedPort) ||
      scopedPort < 1 ||
      scopedPort > 65_535 ||
      !canonicalGatewayTargetMatches(scopedName, scopedPort) ||
      options.usePidFile === false ||
      options.usePgrepFallback === true ||
      explicitPids.length > 0)
  ) {
    return rejectScoped("scoped cleanup requires one canonical name, port, and PID file");
  }

  if (options.usePidFile ?? true) {
    const pidFromFile = readPidFile(pidFile);
    if (pidFromFile !== null) {
      addPid(candidates, pidFromFile, "pid-file");
    } else if (options.scopedGatewayStop) {
      if (
        fs.existsSync(pidFile) ||
        fs.existsSync(getDockerDriverGatewayRuntimeMarkerPath(stateDir)) ||
        deps.isPortFree?.(scopedPort) !== true
      ) {
        return rejectScoped("selected gateway has incomplete ownership evidence");
      }
      if (options.logNoProcesses)
        (deps.log ?? console.log)("No host openshell-gateway processes found");
      return result;
    } else if (clearRuntimeState && fs.existsSync(pidFile)) {
      clearHostGatewayRuntimeFiles(stateDir, pidFile);
    }
  }

  for (const pid of explicitPids) addPid(candidates, pid, "explicit");

  // When a caller passes explicit PIDs (e.g. drift-restart targeting one
  // gateway), default to NOT sweeping every matching openshell-gateway on the
  // host. Otherwise an onboard drift could terminate an unrelated worktree's
  // gateway. Sweeping callers (uninstall, sandbox destroy of the last sandbox)
  // omit `pids` and so still get the pgrep fallback by default.
  const useFallback = options.scopedGatewayStop
    ? false
    : (options.usePgrepFallback ?? explicitPids.length === 0);
  let pgrepRan = false;
  if (useFallback) {
    const sweep = pgrepHostGatewayPids(deps);
    pgrepRan = sweep.scanned;
    result.orphanScanComplete = pgrepRan;
    for (const pid of sweep.pids) addPid(candidates, pid, "pgrep");
  }

  const waitOptions = {
    killWaitMs: options.killWaitMs ?? DEFAULT_KILL_WAIT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    termWaitMs: options.termWaitMs ?? DEFAULT_TERM_WAIT_MS,
  };
  const expectedOpenShellGateway =
    options.openShellGatewayName || options.openShellGatewayPort !== undefined
      ? {
          name: options.openShellGatewayName,
          port: options.openShellGatewayPort,
        }
      : undefined;
  let clearedRuntimeFiles = false;
  for (const [pid, sources] of candidates) {
    const processStatus = hostGatewayProcessStatus(pid, deps);
    if (processStatus === "unknown") {
      if (options.scopedGatewayStop) {
        return rejectScoped("recorded process status cannot be proven", pid);
      }
      result.skippedNonMatchingPids.push(pid);
      continue;
    }
    if (processStatus === "exited") {
      result.skippedDeadPids.push(pid);
      if (options.scopedGatewayStop && deps.isPortFree?.(scopedPort) !== true) {
        return rejectScoped("recorded process is dead but its selected port remains occupied");
      }
      if (clearRuntimeState && sources.has("pid-file") && !clearedRuntimeFiles) {
        clearHostGatewayRuntimeFiles(stateDir, pidFile);
        clearedRuntimeFiles = true;
      }
      continue;
    }
    if (options.scopedGatewayStop) {
      const reason = scopedGatewayOwnershipFailure(pid, deps, options, stateDir, pidFile, {
        name: scopedName,
        port: scopedPort,
      });
      if (reason) return rejectScoped(reason, pid);
    }
    if (
      !options.scopedGatewayStop &&
      !hostGatewayCmdlineMatches(
        processArgs(pid, deps),
        options.gatewayBin,
        expectedOpenShellGateway,
      )
    ) {
      result.skippedNonMatchingPids.push(pid);
      if (
        clearRuntimeState &&
        !options.preserveRuntimeFilesOnNonMatching &&
        sources.has("pid-file") &&
        !clearedRuntimeFiles
      ) {
        clearHostGatewayRuntimeFiles(stateDir, pidFile);
        clearedRuntimeFiles = true;
      }
      continue;
    }
    if (
      !options.scopedGatewayStop &&
      !sources.has("pid-file") &&
      pidBelongsToAnotherUser(pid, deps)
    ) {
      (result.foreignUserPids ??= []).push(pid);
      warnForeignUserGateway(pid, deps);
      continue;
    }

    const stopResult = tryStopPid(
      pid,
      deps,
      waitOptions,
      options.scopedGatewayStop
        ? () => {
            if (hostGatewayProcessStatus(pid, deps) !== "running") return false;
            return (
              scopedGatewayOwnershipFailure(pid, deps, options, stateDir, pidFile, {
                name: scopedName,
                port: scopedPort,
              }) === null
            );
          }
        : undefined,
      {
        name: expectedOpenShellGateway?.name,
        port: Number(expectedOpenShellGateway?.port) || undefined,
      },
    );
    if (stopResult === "identity-changed") {
      return rejectScoped("process ownership changed immediately before signaling", pid);
    }
    if (stopResult === "stopped") {
      result.stopped.push(pid);
      if (options.scopedGatewayStop && deps.isPortFree?.(scopedPort) !== true) {
        return rejectScoped("selected gateway port remains occupied after its process stopped");
      }
      if (clearRuntimeState && !clearedRuntimeFiles) {
        clearHostGatewayRuntimeFiles(stateDir, pidFile);
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
          "Inspect any remaining listener and stop only the matching gateway process.",
      );
    } else {
      const log = deps.log ?? ((message: string) => console.log(message));
      log("No host openshell-gateway processes found");
    }
  }

  return result;
}
