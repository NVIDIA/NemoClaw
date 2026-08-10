// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerForceRm as runDockerForceRm } from "../adapters/docker/container";
import { dockerInspect as runDockerInspect } from "../adapters/docker/inspect";
import type { DockerRunOptions, DockerRunResult } from "../adapters/docker/run";
import { waitUntil } from "../core/wait";
import {
  clearDockerDriverGatewayRuntimeMarker,
  getDockerDriverGatewayRuntimeMarkerPath,
  readDockerDriverGatewayRuntimeMarker,
} from "./docker-driver-gateway-runtime-marker";
import {
  canonicalGatewayTargetMatches,
  cleanGatewayProcessToken,
  DOCKER_DRIVER_GATEWAY_COMPAT_MOUNT_PATH,
  DOCKER_DRIVER_GATEWAY_CONTAINER_RUNTIME_NAMES,
  gatewayCompatContainerNameForPort,
  type OpenShellGatewayProcessTarget,
  hostGatewayCmdlineMatches as sharedHostGatewayCmdlineMatches,
} from "./gateway-process-identity";

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
  dockerForceRm: (
    containerName: string,
    options?: DockerRunOptions,
  ) => Pick<DockerRunResult, "status" | "stdout" | "stderr">;
  dockerInspect: (
    args: readonly string[],
    options?: DockerRunOptions,
  ) => Pick<DockerRunResult, "status" | "stdout" | "stderr">;
  isPortFree?: (port: number) => boolean;
  log?: (message: string) => void;
  readProcessExecutable?: (pid: number) => string | null;
  readProcessEnvironment?: (pid: number) => Record<string, string> | null;
  readProcessStartIdentity?: (pid: number) => string | null;
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
  /**
   * Stop one gateway without invoking OpenShell's shared Docker shutdown cleanup.
   * Requires exact per-gateway PID, runtime-marker, owner, cmdline, and listener proof.
   */
  scopedGatewayStop?: boolean;
  stateDir?: string;
  termWaitMs?: number;
  /** Whether to read and act on the resolved pid file. */
  usePidFile?: boolean;
  usePgrepFallback?: boolean;
}

export interface StopHostGatewayResult {
  failed: number[];
  /** Whether a requested pgrep fallback completed with a usable result. */
  orphanScanComplete?: boolean;
  ownershipFailures: string[];
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
    dockerForceRm: overrides.dockerForceRm ?? runDockerForceRm,
    dockerInspect: overrides.dockerInspect ?? runDockerInspect,
    isPortFree: overrides.isPortFree ?? ((port) => isHostPortFree(port)),
    log: overrides.log,
    readProcessExecutable: overrides.readProcessExecutable,
    readProcessEnvironment: overrides.readProcessEnvironment,
    readProcessStartIdentity: overrides.readProcessStartIdentity,
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

function processExecutable(pid: number, deps: HostGatewayProcessDeps): string | null {
  if (deps.readProcessExecutable) return deps.readProcessExecutable(pid);
  try {
    return fs.readlinkSync(`/proc/${String(pid)}/exe`);
  } catch {
    const lsof = deps.run("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
      env: deps.env,
    });
    const lsofPath =
      lsof.status === 0
        ? lsof.stdout
            .split(/\r?\n/)
            .find((line) => line.startsWith("n/") && line.length > 2)
            ?.slice(1)
        : undefined;
    if (lsofPath) return lsofPath;
    const result = deps.run("ps", ["-p", String(pid), "-o", "comm="], { env: deps.env });
    const executable = result.status === 0 ? result.stdout.trim() : "";
    return executable && path.isAbsolute(executable) ? executable : null;
  }
}

function processStartIdentity(pid: number, deps: HostGatewayProcessDeps): string | null {
  if (deps.readProcessStartIdentity) return deps.readProcessStartIdentity(pid);
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    return (
      stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    const result = deps.run("ps", ["-p", String(pid), "-o", "lstart="], { env: deps.env });
    const started = result.status === 0 ? result.stdout.trim() : "";
    return started ? started : null;
  }
}

function pidExists(pid: number, deps: HostGatewayProcessDeps): boolean {
  return deps.run("ps", ["-p", String(pid), "-o", "pid="], { env: deps.env }).status === 0;
}

function pidOwner(pid: number, deps: HostGatewayProcessDeps): string | null {
  const result = deps.run("ps", ["-p", String(pid), "-o", "user="], { env: deps.env });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function pidUid(pid: number, deps: HostGatewayProcessDeps): number | null {
  const result = deps.run("ps", ["-p", String(pid), "-o", "uid="], { env: deps.env });
  if (result.status !== 0) return null;
  const uid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(uid) && uid >= 0 ? uid : null;
}

function regularFileUid(filePath: string): number | null {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.uid : null;
  } catch {
    return null;
  }
}

function ownedStateDirUid(stateDir: string): number | null {
  try {
    const stat = fs.lstatSync(stateDir);
    return stat.isDirectory() && !stat.isSymbolicLink() ? stat.uid : null;
  } catch {
    return null;
  }
}

function gatewayEndpointPort(endpoint: string): number | null {
  try {
    const parsed = new URL(endpoint);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function listeningPids(
  port: number,
  deps: HostGatewayProcessDeps,
): { complete: boolean; pids: number[] } {
  if (deps.commandExists && !deps.commandExists("lsof")) {
    return { complete: false, pids: [] };
  }
  const result = deps.run("lsof", ["-ti", `:${String(port)}`, "-sTCP:LISTEN"], {
    env: deps.env,
  });
  if (result.status !== 0 && result.status !== 1) {
    return { complete: false, pids: [] };
  }
  return { complete: true, pids: [...new Set(parsePidLines(result.stdout))] };
}

function dockerCompatContainerForTarget(cmdline: string, port: number): string | null {
  const tokens = cmdline.trim().split(/\s+/).filter(Boolean).map(cleanGatewayProcessToken);
  const argv0 = tokens[0] ?? "";
  if (
    !DOCKER_DRIVER_GATEWAY_CONTAINER_RUNTIME_NAMES.has(path.basename(argv0)) ||
    tokens[1] !== "run" ||
    !tokens.slice(1).includes(DOCKER_DRIVER_GATEWAY_COMPAT_MOUNT_PATH)
  ) {
    return null;
  }
  const containerName = gatewayCompatContainerNameForPort(port);
  const nameIndex = tokens.findIndex((token) => token === "--name");
  const inlineName = tokens.find((token) => token.startsWith("--name="))?.slice("--name=".length);
  const explicitName = nameIndex >= 0 ? tokens[nameIndex + 1] : inlineName;
  return explicitName === containerName ? containerName : null;
}

type DockerCompatContainerIdentity = {
  containerId: string;
  containerName: string;
  dockerEnv: NodeJS.ProcessEnv;
  pid: number;
};

function dockerCompatContainerIdentity(
  containerName: string,
  dockerHost: string,
  deps: HostGatewayProcessDeps,
): DockerCompatContainerIdentity | null {
  const dockerEnv = { ...deps.env };
  for (const key of ["DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY"]) {
    delete dockerEnv[key];
  }
  dockerEnv.DOCKER_HOST = dockerHost;
  const result = deps.dockerInspect(["--type", "container", containerName], {
    encoding: "utf-8",
    env: dockerEnv,
    ignoreError: true,
    suppressOutput: true,
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(result.stdout ?? "")) as Array<{
      Args?: unknown;
      HostConfig?: { NetworkMode?: unknown };
      Id?: unknown;
      Name?: unknown;
      Path?: unknown;
      State?: { Pid?: unknown; Running?: unknown };
    }>;
    if (!Array.isArray(parsed) || parsed.length !== 1) return null;
    const container = parsed[0];
    const containerId = typeof container.Id === "string" ? container.Id : "";
    const containerPid = container.State?.Pid;
    if (
      !/^[a-f0-9]{64}$/i.test(containerId) ||
      container.Name !== `/${containerName}` ||
      container.Path !== DOCKER_DRIVER_GATEWAY_COMPAT_MOUNT_PATH ||
      !Array.isArray(container.Args) ||
      container.Args.length !== 0 ||
      container.HostConfig?.NetworkMode !== "host" ||
      container.State?.Running !== true ||
      !Number.isSafeInteger(containerPid) ||
      Number(containerPid) <= 0
    ) {
      return null;
    }
    return {
      containerId,
      containerName,
      dockerEnv,
      pid: Number(containerPid),
    };
  } catch {
    return null;
  }
}

function processEnvironment(
  pid: number,
  deps: HostGatewayProcessDeps,
): Record<string, string> | null {
  if (deps.readProcessEnvironment) return deps.readProcessEnvironment(pid);
  try {
    const entries = fs.readFileSync(`/proc/${String(pid)}/environ`, "utf-8").split("\0");
    const environment: Record<string, string> = {};
    for (const entry of entries) {
      const separator = entry.indexOf("=");
      if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return environment;
  } catch {
    return null;
  }
}

export function hostGatewayCmdlineMatches(
  cmdline: string,
  gatewayBin: string | null | undefined,
  expectedOpenShellGateway?: OpenShellGatewayProcessTarget,
  opts: { requireExpectedFlags?: boolean } = {},
): boolean {
  return sharedHostGatewayCmdlineMatches(cmdline, gatewayBin, expectedOpenShellGateway, opts);
}

function normalizeExecutablePath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function scopedGatewayOwnershipProof(
  pid: number,
  deps: HostGatewayProcessDeps,
  options: StopHostGatewayOptions,
  target: { name: string; port: number },
  stateDir: string,
  pidFile: string,
): {
  cmdline: string;
  compatContainerIdentity?: DockerCompatContainerIdentity;
  compatContainerName: string | null;
  reason?: string;
  startIdentity?: string;
} {
  const markerPath = getDockerDriverGatewayRuntimeMarkerPath(stateDir);
  const stateDirUid = ownedStateDirUid(stateDir);
  const pidFileUid = regularFileUid(pidFile);
  const markerUid = regularFileUid(markerPath);
  if (stateDirUid === null) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: "gateway state directory is missing, symlinked, or not a directory",
    };
  }
  if (pidFileUid === null) {
    return { cmdline: "", compatContainerName: null, reason: "PID file is not a regular file" };
  }
  if (markerUid === null) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: "runtime marker is missing or not a regular file",
    };
  }
  if (stateDirUid !== pidFileUid || pidFileUid !== markerUid) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: "gateway state directory, PID file, and runtime marker have different owners",
    };
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stateDirUid !== currentUid) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: "scoped gateway runtime evidence is not owned by the current user",
    };
  }
  if (readPidFile(pidFile) !== pid) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: "PID file identity changed while proving the scoped gateway target",
    };
  }

  const marker = readDockerDriverGatewayRuntimeMarker(markerPath);
  if (!marker) {
    return { cmdline: "", compatContainerName: null, reason: "runtime marker is invalid" };
  }
  if (marker.pid !== pid) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: `runtime marker PID ${String(marker.pid)} does not match PID file ${String(pid)}`,
    };
  }
  if (gatewayEndpointPort(marker.endpoint) !== target.port) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: `runtime marker endpoint does not identify port ${String(target.port)}`,
    };
  }
  if (marker.platform !== process.platform || marker.arch !== process.arch) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: "runtime marker platform identity does not match this host",
    };
  }
  if (
    marker.gatewayBin &&
    options.gatewayBin &&
    normalizeExecutablePath(marker.gatewayBin) !== normalizeExecutablePath(options.gatewayBin)
  ) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: "runtime marker gateway executable does not match the cleanup target",
    };
  }

  const ownerUid = pidUid(pid, deps);
  if (ownerUid === null || ownerUid !== pidFileUid) {
    return {
      cmdline: "",
      compatContainerName: null,
      reason: "gateway process owner does not match the scoped runtime evidence owner",
    };
  }

  const cmdline = processArgs(pid, deps);
  if (
    !hostGatewayCmdlineMatches(cmdline, options.gatewayBin, target, {
      requireExpectedFlags: true,
    })
  ) {
    return {
      cmdline,
      compatContainerName: null,
      reason: `process command line does not prove gateway '${target.name}' on port ${String(target.port)}`,
    };
  }

  const compatContainerName = dockerCompatContainerForTarget(cmdline, target.port);
  if (!compatContainerName) {
    if (!marker.gatewayBin) {
      return {
        cmdline,
        compatContainerName,
        reason: "runtime marker does not identify the direct gateway executable",
      };
    }
    const executable = processExecutable(pid, deps);
    if (
      !executable ||
      normalizeExecutablePath(executable) !== normalizeExecutablePath(marker.gatewayBin)
    ) {
      return {
        cmdline,
        compatContainerName,
        reason: "gateway process executable does not match the runtime marker",
      };
    }
  }
  const startIdentity = processStartIdentity(pid, deps);
  if (!startIdentity) {
    return {
      cmdline,
      compatContainerName,
      reason: "gateway process start identity could not be proven",
    };
  }
  const listeners = listeningPids(target.port, deps);
  if (!listeners.complete) {
    return {
      cmdline,
      compatContainerName,
      reason: `listener ownership for port ${String(target.port)} could not be observed completely`,
    };
  }
  if (compatContainerName) {
    const parentEnvironment = processEnvironment(pid, deps);
    const parentDockerHost = parentEnvironment?.DOCKER_HOST?.trim() || null;
    const provenDockerHost = marker.dockerHost ?? "unix:///var/run/docker.sock";
    const unsupportedDockerSelector = [
      "DOCKER_CERT_PATH",
      "DOCKER_CONFIG",
      "DOCKER_CONTEXT",
      "DOCKER_TLS_VERIFY",
    ].some((key) => Boolean(parentEnvironment?.[key]?.trim()));
    if (
      marker.gatewayBin !== null ||
      !provenDockerHost.startsWith("unix:///") ||
      !parentEnvironment ||
      unsupportedDockerSelector ||
      (marker.dockerHost === null
        ? parentDockerHost !== null
        : parentDockerHost !== marker.dockerHost)
    ) {
      return {
        cmdline,
        compatContainerName,
        reason: "compatibility gateway Docker daemon identity does not match the runtime marker",
      };
    }
    const compatContainerIdentity = dockerCompatContainerIdentity(
      compatContainerName,
      provenDockerHost,
      deps,
    );
    if (!compatContainerIdentity) {
      return {
        cmdline,
        compatContainerName,
        reason: `compatibility container '${compatContainerName}' identity could not be proven`,
      };
    }
    if (listeners.pids.length !== 1 || listeners.pids[0] !== compatContainerIdentity.pid) {
      return {
        cmdline,
        compatContainerName,
        reason: `compatibility container '${compatContainerName}' does not solely own the listener on port ${String(target.port)}`,
      };
    }
    return { cmdline, compatContainerIdentity, compatContainerName, startIdentity };
  } else if (listeners.pids.length !== 1 || listeners.pids[0] !== pid) {
    return {
      cmdline,
      compatContainerName,
      reason: `PID ${String(pid)} is not the sole listener owner for port ${String(target.port)}`,
    };
  }

  return { cmdline, compatContainerName, startIdentity };
}

function waitForExit(
  pid: number,
  deps: HostGatewayProcessDeps,
  timeoutMs: number,
  pollIntervalMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  return (
    waitUntil(() => !pidExists(pid, deps), {
      deadlineMs: deadline,
      initialIntervalMs: pollIntervalMs,
      maxIntervalMs: pollIntervalMs,
      backoffFactor: 1,
    }) || !pidExists(pid, deps)
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

function warnSudoRemediation(pid: number, deps: HostGatewayProcessDeps): void {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const owner = pidOwner(pid, deps);
  const ownerLabel = owner ? `${owner}-owned` : "privileged";
  warn(
    `Cannot stop ${ownerLabel} host openshell-gateway process ${pid}. ` +
      `Run: sudo kill -9 ${pid}`,
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

function tryStopScopedPid(
  pid: number,
  compatContainerIdentity: DockerCompatContainerIdentity | undefined,
  expectedStartIdentity: string,
  deps: HostGatewayProcessDeps,
  options: Required<Pick<StopHostGatewayOptions, "killWaitMs" | "pollIntervalMs">>,
): "stopped" | "failed" | "identity-changed" {
  const log = deps.log ?? ((message: string) => console.log(message));
  if (processStartIdentity(pid, deps) !== expectedStartIdentity) return "identity-changed";
  if (compatContainerIdentity) {
    const removed = deps.dockerForceRm(compatContainerIdentity.containerId, {
      encoding: "utf-8",
      env: compatContainerIdentity.dockerEnv,
      ignoreError: true,
      suppressOutput: true,
    });
    if (removed.status !== 0) {
      const warn = deps.warn ?? ((message: string) => console.warn(message));
      const detail = String(removed.stderr ?? "").trim() || `status ${String(removed.status)}`;
      warn(
        `Failed to remove scoped gateway compatibility container '${compatContainerIdentity.containerName}': ${detail}`,
      );
      return "failed";
    }
    if (!waitForExit(pid, deps, options.killWaitMs, options.pollIntervalMs)) {
      return "failed";
    }
  } else {
    // OpenShell 0.0.99 gracefully stops every managed Docker container in its
    // configured namespace. Scoped teardown has already deleted this gateway's
    // selected sandboxes, so SIGKILL avoids cross-stopping a sibling gateway's
    // container while still targeting only the fully proven process.
    deps.kill(pid, "SIGKILL");
  }
  if (waitForExit(pid, deps, options.killWaitMs, options.pollIntervalMs)) {
    log(`Stopped scoped host openshell-gateway process ${pid}`);
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
  const clearRuntimeState = options.clearRuntimeFiles ?? true;
  const candidates = new Map<number, Set<string>>();
  const result: StopHostGatewayResult = {
    failed: [],
    orphanScanComplete: true,
    ownershipFailures: [],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    stopped: [],
    sudoRemediationPids: [],
  };

  const scopedGatewayStop = options.scopedGatewayStop ?? false;
  const explicitPids = Array.from(options.pids ?? []).filter(
    (pid): pid is number => Number.isInteger(pid) && pid > 0,
  );
  let scopedTarget: { name: string; port: number } | null = null;
  if (scopedGatewayStop) {
    const port = Number(options.openShellGatewayPort);
    const name = options.openShellGatewayName?.trim() ?? "";
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !canonicalGatewayTargetMatches(name, port)
    ) {
      result.ownershipFailures.push(
        "scoped gateway stop requires one canonical gateway name and port",
      );
      return result;
    }
    if (options.usePidFile === false || explicitPids.length > 0) {
      result.ownershipFailures.push(
        "scoped gateway stop accepts only the selected gateway PID file",
      );
      return result;
    }
    if (options.usePgrepFallback === true) {
      result.ownershipFailures.push("scoped gateway stop forbids host-wide process discovery");
      return result;
    }
    scopedTarget = { name, port };
  }

  if (options.usePidFile ?? true) {
    const pidFromFile = readPidFile(pidFile);
    if (pidFromFile !== null) {
      addPid(candidates, pidFromFile, "pid-file");
    } else if (scopedTarget) {
      const markerPath = getDockerDriverGatewayRuntimeMarkerPath(stateDir);
      if (fs.existsSync(pidFile) || fs.existsSync(markerPath)) {
        result.ownershipFailures.push(
          "scoped gateway PID/runtime evidence is incomplete or invalid",
        );
        return result;
      }
      const listeners = listeningPids(scopedTarget.port, deps);
      if (deps.isPortFree?.(scopedTarget.port) !== true || listeners.pids.length > 0) {
        result.ownershipFailures.push(
          `gateway port ${String(scopedTarget.port)} is occupied without PID-file ownership evidence`,
        );
        return result;
      }
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
  const useFallback = scopedGatewayStop
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
    if (!pidExists(pid, deps)) {
      result.skippedDeadPids.push(pid);
      if (scopedTarget) {
        const listeners = listeningPids(scopedTarget.port, deps);
        if (deps.isPortFree?.(scopedTarget.port) !== true || listeners.pids.length > 0) {
          result.ownershipFailures.push(
            `recorded PID ${String(pid)} is dead but port ${String(scopedTarget.port)} remains occupied`,
          );
          continue;
        }
      }
      if (clearRuntimeState && sources.has("pid-file") && !clearedRuntimeFiles) {
        clearHostGatewayRuntimeFiles(stateDir, pidFile);
        clearedRuntimeFiles = true;
      }
      continue;
    }

    if (scopedTarget) {
      const proof = scopedGatewayOwnershipProof(
        pid,
        deps,
        options,
        scopedTarget,
        stateDir,
        pidFile,
      );
      if (proof.reason) {
        result.skippedNonMatchingPids.push(pid);
        result.ownershipFailures.push(`PID ${String(pid)}: ${proof.reason}`);
        continue;
      }
      const finalProof = scopedGatewayOwnershipProof(
        pid,
        deps,
        options,
        scopedTarget,
        stateDir,
        pidFile,
      );
      if (
        finalProof.reason ||
        finalProof.cmdline !== proof.cmdline ||
        finalProof.startIdentity !== proof.startIdentity ||
        finalProof.compatContainerIdentity?.containerId !==
          proof.compatContainerIdentity?.containerId
      ) {
        result.skippedNonMatchingPids.push(pid);
        result.ownershipFailures.push(
          `PID ${String(pid)}: gateway process identity changed immediately before signaling`,
        );
        continue;
      }
      const scopedStop = tryStopScopedPid(
        pid,
        finalProof.compatContainerIdentity,
        finalProof.startIdentity as string,
        deps,
        waitOptions,
      );
      if (scopedStop === "identity-changed") {
        result.skippedNonMatchingPids.push(pid);
        result.ownershipFailures.push(
          `PID ${String(pid)}: gateway process identity changed immediately before signaling`,
        );
        continue;
      }
      if (scopedStop !== "stopped") {
        result.failed.push(pid);
        result.sudoRemediationPids.push(pid);
        continue;
      }
      result.stopped.push(pid);
      if (!deps.isPortFree?.(scopedTarget.port)) {
        result.ownershipFailures.push(
          `gateway port ${String(scopedTarget.port)} remains occupied after stopping PID ${String(pid)}`,
        );
        continue;
      }
      if (clearRuntimeState && !clearedRuntimeFiles) {
        clearHostGatewayRuntimeFiles(stateDir, pidFile);
        clearedRuntimeFiles = true;
      }
      continue;
    }

    if (
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

    if (tryStopPid(pid, deps, waitOptions) === "stopped") {
      result.stopped.push(pid);
      if (clearRuntimeState && !clearedRuntimeFiles) {
        clearHostGatewayRuntimeFiles(stateDir, pidFile);
        clearedRuntimeFiles = true;
      }
    } else {
      result.failed.push(pid);
      result.sudoRemediationPids.push(pid);
    }
  }

  if (options.logNoProcesses && candidates.size === 0 && result.ownershipFailures.length === 0) {
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
