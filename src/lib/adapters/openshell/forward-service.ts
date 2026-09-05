// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { isValidName } from "../../name-validation";
import { buildOpenShellSubprocessEnv } from "./resolve-shared";
import { probeLocalForwardListener } from "./local-forward-listener";

const START_TIMEOUT_MS = 90_000;
const START_RETRY_DELAY_MS = 1_000;
const START_ATTEMPTS = 2;
const SANDBOX_READY_RETRY_DELAY_MS = 5_000;
const SANDBOX_READY_MAX_RETRIES = 12;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
// OpenShell checks the sandbox every two seconds after binding. Keep the
// listener owned through one complete post-bind check before callers connect.
const STABLE_LISTENER_OBSERVATIONS = 26;
const FORWARD_INSTANCE_ENV = "NEMOCLAW_FORWARD_INSTANCE_ID";
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

type ForwardServiceChild = {
  readonly pid?: number;
  readonly readOutput?: () => string;
  readonly removeOutput?: () => void;
  unref(): void;
};

export interface ForwardServiceTarget {
  readonly executable: string;
  readonly gatewayName: string;
  readonly workspace: string;
  readonly sandboxName: string;
  readonly localHost: "127.0.0.1" | "0.0.0.0";
  readonly localPort: number;
  readonly targetHost: "127.0.0.1";
  readonly targetPort: number;
}

export interface ForwardServiceLaunchOptions {
  readonly describeState?: () => string | null | undefined;
  readonly getProcessIdentity?: (pid: number) => string | null | undefined;
  readonly isProcessRunning?: (pid: number) => boolean;
  readonly isListenerOwned?: (pid: number, port: number) => boolean | null;
  readonly isReachable?: (port: number) => boolean;
  readonly maxAttempts?: number;
  readonly maxSandboxReadyRetries?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (milliseconds: number) => void;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly stopProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly stopTimeoutMs?: number;
  readonly spawnDetached?: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ForwardServiceChild;
  readonly timeoutMs?: number;
}

function readLinuxProcessStat(pid: number): string[] | null | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ESRCH" ? null : undefined;
  }
}

export function parseForwardInstanceIdentity(
  output: string,
  platform = process.platform,
): string | undefined {
  const match = new RegExp(
    `(?:^|\\s)${FORWARD_INSTANCE_ENV}=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\s|$)`,
    "iu",
  ).exec(output);
  return match?.[1] ? `${platform}:${match[1].toLowerCase()}` : undefined;
}

function getProcessIdentity(pid: number): string | null | undefined {
  const stat = readLinuxProcessStat(pid);
  const startTime = stat?.[19];
  if (startTime && /^\d+$/u.test(startTime)) return `linux:${startTime}`;
  if (stat === null) return null;
  if (process.platform === "linux") return undefined;
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    env: buildOpenShellSubprocessEnv(process.env),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
  if (result.error) return undefined;
  const identity = result.status === 0 ? parseForwardInstanceIdentity(result.stdout) : undefined;
  if (identity) return identity;
  return result.status === 1 ? null : undefined;
}

function readLinuxListeningSocketInodes(port: number): Set<string> | null {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  let readTable = false;
  for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let table: string;
    try {
      table = fs.readFileSync(tablePath, "utf8");
      readTable = true;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOENT") continue;
      return null;
    }
    for (const line of table.split(/\r?\n/u).slice(1)) {
      const fields = line.trim().split(/\s+/u);
      const localAddress = fields[1];
      const state = fields[3];
      const inode = fields[9];
      if (
        localAddress?.endsWith(`:${expectedPort}`) &&
        state === "0A" &&
        inode !== undefined &&
        /^\d+$/u.test(inode)
      ) {
        inodes.add(inode);
      }
    }
  }
  return readTable ? inodes : null;
}

function isLinuxListenerOwned(pid: number, port: number): boolean | null {
  const listenerInodes = readLinuxListeningSocketInodes(port);
  if (!listenerInodes) return null;
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(`/proc/${String(pid)}/fd`);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ESRCH" ? false : null;
  }
  let unreadableDescriptor = false;
  for (const descriptor of descriptors) {
    try {
      const target = fs.readlinkSync(`/proc/${String(pid)}/fd/${descriptor}`);
      const match = /^socket:\[(\d+)\]$/u.exec(target);
      if (match?.[1] && listenerInodes.has(match[1])) return true;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ESRCH") unreadableDescriptor = true;
    }
  }
  return unreadableDescriptor ? null : false;
}

export function getForwardListenerOwnership(pid: number, port: number): boolean | null {
  if (process.platform === "linux") return isLinuxListenerOwned(pid, port);
  const result = spawnSync(
    "lsof",
    ["-nP", "-a", "-p", String(pid), `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"],
    {
      encoding: "utf8",
      env: buildOpenShellSubprocessEnv(process.env),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    },
  );
  if (result.error) return null;
  const listenerPids = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (result.status === 0) return listenerPids.includes(String(pid));
  return result.status === 1 && listenerPids.length === 0 ? false : null;
}

function isProcessRunning(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      // Signal 0 still reports a zombie as present. Read its state so a failed
      // forward may be retried without starting alongside a live process.
      const stat = readLinuxProcessStat(pid);
      if (stat === null) return false;
      if (stat?.[0] === "Z") return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code !== "ENOENT" && code !== "ESRCH";
  }
}

function boundedState(description: string | null | undefined): string {
  const compact = (description ?? "").replace(/\s+/gu, " ").trim();
  return compact ? compact.slice(0, 240) : "<empty>";
}

function describeFailureState(describe: (() => string | null | undefined) | undefined): string {
  try {
    return boundedState(describe?.());
  } catch {
    return "<unavailable>";
  }
}

function spawnForwardService(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): ForwardServiceChild {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forward-service-"));
  fs.chmodSync(outputDirectory, 0o700);
  const outputPath = path.join(outputDirectory, "start.log");
  const outputDescriptor = fs.openSync(outputPath, "wx", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, [...args], {
      detached: true,
      env: environment,
      stdio: ["ignore", outputDescriptor, outputDescriptor],
    });
  } catch (error) {
    try {
      fs.closeSync(outputDescriptor);
    } catch {
      // Preserve the spawn failure if closing its diagnostic file also fails.
    }
    try {
      fs.rmSync(outputDirectory, { force: true, recursive: true });
    } catch {
      // Preserve the spawn failure if removing its diagnostic file also fails.
    }
    throw error;
  }
  try {
    fs.closeSync(outputDescriptor);
  } catch {
    // The child owns its inherited descriptor; the parent no longer needs it.
  }
  return {
    pid: child.pid,
    unref: () => child.unref(),
    readOutput: () => {
      try {
        return fs.readFileSync(outputPath, "utf8");
      } catch {
        return "";
      }
    },
    removeOutput: () => {
      try {
        fs.rmSync(outputDirectory, { force: true, recursive: true });
      } catch {
        // The detached child may still hold the file on non-POSIX hosts.
      }
    },
  };
}

function readForwardStartState(child: ForwardServiceChild): {
  readonly diagnostic: string;
  readonly sandboxReadinessHandoff: boolean;
} {
  const output = child.readOutput?.() ?? "";
  const sandboxReadinessHandoff = isSandboxReadinessHandoff(output);
  return {
    diagnostic: sandboxReadinessHandoff
      ? "sandbox readiness handoff"
      : output.trim()
        ? "non-readiness OpenShell diagnostic"
        : "<empty>",
    sandboxReadinessHandoff,
  };
}

function isSandboxReadinessHandoff(output: string): boolean {
  // Miette adds box-drawing lines and arrows around OpenShell errors. Retain
  // only characters that can belong to the two readiness messages so the
  // classification does not depend on its renderer or terminal width.
  const compact = stripVTControlCharacters(output)
    .replace(/[^\p{L}\p{N}\s'"():;._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    /message: ["']sandbox is not ready["']/iu.test(compact) ||
    /sandbox ["'][^"']+["'] is no longer ready \(phase: [^)]+\); stopping service forward/iu.test(
      compact,
    )
  );
}

function removeForwardStartOutput(child: ForwardServiceChild): void {
  child.removeOutput?.();
}

function isProcessIdentity(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && Number(pid) > 0;
}

function isMissingProcessError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ESRCH";
}

type OwnedProcessStopResult = "stopped" | "running" | "unverified";

function processIdentityStatus(
  pid: number,
  expectedIdentity: string | null | undefined,
  readIdentity: (pid: number) => string | null | undefined,
): "owned" | "exited" | "unverified" {
  if (!expectedIdentity) return "unverified";
  const observedIdentity = readIdentity(pid);
  if (observedIdentity === null) return "exited";
  return observedIdentity === expectedIdentity ? "owned" : "unverified";
}

function waitForProcessExit(
  pid: number,
  expectedIdentity: string,
  readIdentity: (pid: number) => string | null | undefined,
  processIsRunning: (pid: number) => boolean,
  sleep: (milliseconds: number) => void,
  timeoutMs: number,
): OwnedProcessStopResult {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const identityStatus = processIdentityStatus(pid, expectedIdentity, readIdentity);
    if (identityStatus === "exited" || !processIsRunning(pid)) return "stopped";
    if (identityStatus === "unverified") return "unverified";
    if (Date.now() >= deadline) return "running";
    sleep(POLL_INTERVAL_MS);
  }
}

function stopOwnedProcess(
  pid: number,
  expectedIdentity: string | null | undefined,
  readIdentity: (pid: number) => string | null | undefined,
  processIsRunning: (pid: number) => boolean,
  stopProcess: (pid: number, signal: NodeJS.Signals) => void,
  sleep: (milliseconds: number) => void,
  timeoutMs: number,
): OwnedProcessStopResult {
  if (!expectedIdentity) return "unverified";
  const identity = expectedIdentity;
  const initialStatus = processIdentityStatus(pid, identity, readIdentity);
  if (initialStatus === "exited") return "stopped";
  if (initialStatus === "unverified") return "unverified";
  try {
    stopProcess(pid, "SIGTERM");
  } catch (error) {
    if (isMissingProcessError(error)) return "stopped";
    return "running";
  }
  const termResult = waitForProcessExit(
    pid,
    identity,
    readIdentity,
    processIsRunning,
    sleep,
    timeoutMs,
  );
  if (termResult !== "running") return termResult;
  if (processIdentityStatus(pid, identity, readIdentity) !== "owned") {
    return "unverified";
  }
  try {
    stopProcess(pid, "SIGKILL");
  } catch (error) {
    if (isMissingProcessError(error)) return "stopped";
    return "running";
  }
  return waitForProcessExit(pid, identity, readIdentity, processIsRunning, sleep, timeoutMs);
}

function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function isCanonicalNemoClawGatewayName(value: string): boolean {
  if (value === "nemoclaw") return true;
  const match = /^nemoclaw-([1-9]\d{0,4})$/u.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 && port !== 8_080;
}

export function validateForwardServiceTarget(target: ForwardServiceTarget): ForwardServiceTarget {
  if (!path.isAbsolute(target.executable) || target.executable.includes("\0")) {
    throw new Error("OpenShell forward service executable must be an absolute path");
  }
  if (!isCanonicalNemoClawGatewayName(target.gatewayName)) {
    throw new Error("OpenShell forward service gateway must be a canonical NemoClaw gateway");
  }
  if (!isValidName(target.workspace)) {
    throw new Error("OpenShell forward service workspace is invalid");
  }
  if (!isValidName(target.sandboxName)) {
    throw new Error("OpenShell forward service sandbox name is invalid");
  }
  if (target.localHost !== "127.0.0.1" && target.localHost !== "0.0.0.0") {
    throw new Error("OpenShell forward service local host must be IPv4 loopback or all interfaces");
  }
  if (!isPort(target.localPort) || !isPort(target.targetPort)) {
    throw new Error("OpenShell forward service ports must be between 1 and 65535");
  }
  if (target.targetHost !== "127.0.0.1") {
    throw new Error("OpenShell forward service target host must be IPv4 loopback");
  }
  return target;
}

/** Build the direct ForwardTcp command introduced in OpenShell 0.0.106. */
export function buildForwardServiceArgs(target: ForwardServiceTarget): string[] {
  validateForwardServiceTarget(target);
  return [
    "--gateway",
    target.gatewayName,
    "--workspace",
    target.workspace,
    "forward",
    "service",
    target.sandboxName,
    "--target-port",
    String(target.targetPort),
    "--target-host",
    target.targetHost,
    "--local",
    `${target.localHost}:${String(target.localPort)}`,
  ];
}

/** Launch one foreground OpenShell service forward as a detached host child. */
export function launchForwardService(
  target: ForwardServiceTarget,
  options: ForwardServiceLaunchOptions = {},
): void {
  validateForwardServiceTarget(target);
  const isReachable = options.isReachable ?? probeLocalForwardListener;
  const processIsRunning = options.isProcessRunning ?? isProcessRunning;
  const readProcessIdentity = options.getProcessIdentity ?? getProcessIdentity;
  const listenerIsOwned = options.isListenerOwned ?? getForwardListenerOwnership;
  if (isReachable(target.localPort)) {
    throw new Error(`Host port ${String(target.localPort)} is already occupied`);
  }
  const spawnDetached =
    options.spawnDetached ??
    ((executable, args, environment) => spawnForwardService(executable, args, environment));
  const sleep =
    options.sleep ?? ((milliseconds: number) => Atomics.wait(sleepBuffer, 0, 0, milliseconds));
  const stopProcess =
    options.stopProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const attempts = options.maxAttempts ?? START_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > START_ATTEMPTS) {
    throw new Error(`OpenShell forward service attempts must be between 1 and ${START_ATTEMPTS}`);
  }
  const maxSandboxReadyRetries = options.maxSandboxReadyRetries ?? SANDBOX_READY_MAX_RETRIES;
  if (
    !Number.isSafeInteger(maxSandboxReadyRetries) ||
    maxSandboxReadyRetries < 0 ||
    maxSandboxReadyRetries > SANDBOX_READY_MAX_RETRIES
  ) {
    throw new Error(
      `OpenShell sandbox readiness retries must be between 0 and ${SANDBOX_READY_MAX_RETRIES}`,
    );
  }
  const args = buildForwardServiceArgs(target);
  const baseEnvironment = buildOpenShellSubprocessEnv(options.sourceEnvironment ?? process.env);
  let finalFailure = "exited before binding";
  let finalStartState = { diagnostic: "<empty>", sandboxReadinessHandoff: false };
  let attempt = 0;
  let standardFailures = 0;
  let sandboxReadyRetries = 0;
  while (true) {
    attempt += 1;
    finalFailure = "exited before binding";
    if (isReachable(target.localPort)) {
      throw new Error(
        `Host port ${String(target.localPort)} became occupied before forward retry; refusing to adopt its listener`,
      );
    }
    const instanceId = randomUUID();
    const environment = { ...baseEnvironment, [FORWARD_INSTANCE_ENV]: instanceId };
    const child = spawnDetached(target.executable, args, environment);
    if (!isProcessIdentity(child.pid)) {
      finalStartState = readForwardStartState(child);
      removeForwardStartOutput(child);
      throw new Error(
        `OpenShell forward service returned no process identity for ${target.localHost}:${String(target.localPort)}; ` +
          `refusing to start a duplicate service; forward start: ${finalStartState.diagnostic}; forward list: ${describeFailureState(options.describeState)}`,
      );
    }
    const childIdentity = options.getProcessIdentity
      ? readProcessIdentity(child.pid)
      : process.platform === "linux"
        ? readProcessIdentity(child.pid)
        : `${process.platform}:${instanceId}`;
    child.unref();
    const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
    let exited = false;
    let ownershipLost = false;
    let stableListenerObservations = 0;
    while (true) {
      if (childIdentity) {
        const identityStatus = processIdentityStatus(child.pid, childIdentity, readProcessIdentity);
        if (identityStatus === "exited") {
          exited = true;
          break;
        }
        if (identityStatus === "unverified") {
          ownershipLost = true;
          break;
        }
      }
      if (isProcessIdentity(child.pid) && !processIsRunning(child.pid)) {
        exited = true;
        break;
      }
      const listenerOwnership = listenerIsOwned(child.pid, target.localPort);
      if (
        listenerOwnership === true &&
        processIdentityStatus(child.pid, childIdentity, readProcessIdentity) === "owned"
      ) {
        stableListenerObservations += 1;
        if (stableListenerObservations >= STABLE_LISTENER_OBSERVATIONS) {
          removeForwardStartOutput(child);
          return;
        }
      } else {
        stableListenerObservations = 0;
      }
      // OpenShell opens the host listener before it creates a sandbox relay.
      // Connecting here is not a passive readiness check: the accepted socket
      // starts ForwardTcp, and a sandbox that is still settling can reject that
      // first relay and make the foreground service exit. Inspect the launched
      // process's listener ownership without connecting to the service.
      // The bind deadline governs the first owned-listener observation. Once
      // binding starts, finish the short stability window instead of timing
      // out a service that bound at the edge of the deadline.
      if (Date.now() >= deadline && stableListenerObservations === 0) break;
      sleep(POLL_INTERVAL_MS);
    }
    if (ownershipLost) {
      finalStartState = readForwardStartState(child);
      removeForwardStartOutput(child);
      throw new Error(
        `OpenShell forward service process ${String(child.pid)} changed identity before binding ${target.localHost}:${String(target.localPort)}; ` +
          `refusing to signal or retry; forward start: ${finalStartState.diagnostic}; forward list: ${describeFailureState(options.describeState)}`,
      );
    }
    if (!exited) {
      const stopResult = stopOwnedProcess(
        child.pid,
        childIdentity,
        readProcessIdentity,
        processIsRunning,
        stopProcess,
        sleep,
        options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
      );
      if (stopResult !== "stopped") {
        finalStartState = readForwardStartState(child);
        removeForwardStartOutput(child);
        const reason =
          stopResult === "unverified"
            ? "could not verify that it still owned that process"
            : "could not stop that process";
        throw new Error(
          `OpenShell forward service process ${String(child.pid)} remained unbound after ${String(options.timeoutMs ?? START_TIMEOUT_MS)}ms and ${reason}; ` +
            `refusing to signal or retry; forward start: ${finalStartState.diagnostic}; forward list: ${describeFailureState(options.describeState)}`,
        );
      }
      if (isReachable(target.localPort)) {
        finalStartState = readForwardStartState(child);
        removeForwardStartOutput(child);
        throw new Error(
          `Host port ${String(target.localPort)} remained reachable after the launched process stopped; ` +
            `refusing to adopt its listener or retry; forward start: ${finalStartState.diagnostic}; forward list: ${describeFailureState(options.describeState)}`,
        );
      }
      finalFailure = "was stopped after failing to bind";
    }
    finalStartState = readForwardStartState(child);
    removeForwardStartOutput(child);
    if (exited && finalStartState.sandboxReadinessHandoff) {
      if (sandboxReadyRetries >= maxSandboxReadyRetries) break;
      sandboxReadyRetries += 1;
      sleep(SANDBOX_READY_RETRY_DELAY_MS);
      continue;
    }
    standardFailures += 1;
    if (standardFailures >= attempts) break;
    sleep(options.retryDelayMs ?? START_RETRY_DELAY_MS);
  }
  throw new Error(
    `OpenShell forward service ${finalFailure} ${target.localHost}:${String(target.localPort)} after ${String(attempt)} attempts; ` +
      `forward start: ${finalStartState.diagnostic}; forward list: ${describeFailureState(options.describeState)}`,
  );
}
