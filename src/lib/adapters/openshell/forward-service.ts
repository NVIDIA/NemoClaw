// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isValidName } from "../../name-validation";
import { buildOpenShellSubprocessEnv } from "./resolve-shared";
import { probeLocalForwardListener } from "./local-forward-listener";

const START_TIMEOUT_MS = 90_000;
const START_RETRY_DELAY_MS = 1_000;
const START_ATTEMPTS = 2;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

type ForwardServiceChild = {
  readonly pid?: number;
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
  readonly isReachable?: (port: number) => boolean;
  readonly maxAttempts?: number;
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

function getProcessIdentity(pid: number): string | null | undefined {
  const stat = readLinuxProcessStat(pid);
  const startTime = stat?.[19];
  return startTime && /^\d+$/u.test(startTime) ? startTime : stat === null ? null : undefined;
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
  return waitForProcessExit(
    pid,
    identity,
    readIdentity,
    processIsRunning,
    sleep,
    timeoutMs,
  );
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
  if (isReachable(target.localPort)) {
    throw new Error(`Host port ${String(target.localPort)} is already occupied`);
  }
  const spawnDetached =
    options.spawnDetached ??
    ((executable, args, environment) =>
      spawn(executable, [...args], { detached: true, env: environment, stdio: "ignore" }));
  const sleep =
    options.sleep ?? ((milliseconds: number) => Atomics.wait(sleepBuffer, 0, 0, milliseconds));
  const stopProcess =
    options.stopProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const attempts = options.maxAttempts ?? START_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > START_ATTEMPTS) {
    throw new Error(`OpenShell forward service attempts must be between 1 and ${START_ATTEMPTS}`);
  }
  const args = buildForwardServiceArgs(target);
  const environment = buildOpenShellSubprocessEnv(options.sourceEnvironment ?? process.env);
  let finalFailure = "exited before binding";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    finalFailure = "exited before binding";
    if (isReachable(target.localPort)) {
      throw new Error(
        `Host port ${String(target.localPort)} became occupied before forward retry; refusing to adopt its listener`,
      );
    }
    const child = spawnDetached(target.executable, args, environment);
    if (!isProcessIdentity(child.pid)) {
      throw new Error(
        `OpenShell forward service returned no process identity for ${target.localHost}:${String(target.localPort)}; ` +
          `refusing to start a duplicate service; forward list: ${describeFailureState(options.describeState)}`,
      );
    }
    const childIdentity = readProcessIdentity(child.pid);
    child.unref();
    const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
    let exited = false;
    let ownershipLost = false;
    while (true) {
      if (childIdentity) {
        const identityStatus = processIdentityStatus(
          child.pid,
          childIdentity,
          readProcessIdentity,
        );
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
      if (isReachable(target.localPort)) {
        return;
      }
      if (Date.now() >= deadline) break;
      sleep(POLL_INTERVAL_MS);
    }
    if (ownershipLost) {
      throw new Error(
        `OpenShell forward service process ${String(child.pid)} changed identity before binding ${target.localHost}:${String(target.localPort)}; ` +
          `refusing to signal or retry; forward list: ${describeFailureState(options.describeState)}`,
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
        const reason =
          stopResult === "unverified"
            ? "could not verify that it still owned that process"
            : "could not stop that process";
        throw new Error(
          `OpenShell forward service process ${String(child.pid)} remained unbound after ${String(options.timeoutMs ?? START_TIMEOUT_MS)}ms and ${reason}; ` +
            `refusing to signal or retry; forward list: ${describeFailureState(options.describeState)}`,
        );
      }
      finalFailure = "was stopped after failing to bind";
    }
    if (attempt < attempts) {
      sleep(options.retryDelayMs ?? START_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `OpenShell forward service ${finalFailure} ${target.localHost}:${String(target.localPort)} after ${String(attempts)} attempts; ` +
      `forward list: ${describeFailureState(options.describeState)}`,
  );
}
