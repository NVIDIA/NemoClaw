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

const START_TIMEOUT_MS = 30_000;
const SANDBOX_CREATING_RETRY_INTERVAL_MS = 2_000;
const SANDBOX_CREATING_MAX_RETRIES = START_TIMEOUT_MS / SANDBOX_CREATING_RETRY_INTERVAL_MS;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
// OpenShell 0.0.106 rechecks sandbox readiness every two seconds after it
// binds. Re-prove exact listener ownership after the next complete check.
const LISTENER_RECHECK_DELAY_MS = SANDBOX_CREATING_RETRY_INTERVAL_MS + POLL_INTERVAL_MS;
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
  readonly getProcessIdentity?: (pid: number) => string | null | undefined;
  readonly isListenerOwned?: (pid: number, port: number) => boolean | null;
  readonly isProcessRunning?: (pid: number) => boolean;
  readonly isReachable?: (port: number) => boolean;
  readonly maxSandboxCreatingRetries?: number;
  readonly onSandboxCreatingRetry?: (evidence: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly processId: number;
    readonly remainingMs: number;
  }) => void;
  readonly sleep?: (milliseconds: number) => void;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly spawnDetached?: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ForwardServiceChild;
  readonly stopProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly stopTimeoutMs?: number;
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

function parseForwardInstanceIdentity(output: string): string | undefined {
  const match = new RegExp(
    `(?:^|\\s)${FORWARD_INSTANCE_ENV}=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\s|$)`,
    "iu",
  ).exec(output);
  return match?.[1] ? `${process.platform}:${match[1].toLowerCase()}` : undefined;
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

function linuxProcessOwnsListener(
  pid: number,
  listenerInodes: ReadonlySet<string>,
): boolean | null {
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

type ForwardListenerObservation = "owned" | "absent" | "foreign" | "unavailable";

function observeLinuxForwardListener(pid: number, port: number): ForwardListenerObservation {
  const listenerInodes = readLinuxListeningSocketInodes(port);
  if (listenerInodes === null) return "unavailable";
  if (listenerInodes.size === 0) return "absent";
  const owned = linuxProcessOwnsListener(pid, listenerInodes);
  if (owned === null) return "unavailable";
  return owned ? "owned" : "foreign";
}

/** Prove that a listener belongs to the exact child requested by this launch. */
export function getForwardListenerOwnership(pid: number, port: number): boolean | null {
  if (process.platform === "linux") {
    const observation = observeLinuxForwardListener(pid, port);
    return observation === "owned" ? true : observation === "unavailable" ? null : false;
  }
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
      const stat = readLinuxProcessStat(pid);
      if (stat === null || stat?.[0] === "Z") return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code !== "ENOENT" && code !== "ESRCH";
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
      // Preserve the spawn failure when closing the diagnostic file also fails.
    }
    try {
      fs.rmSync(outputDirectory, { force: true, recursive: true });
    } catch {
      // Preserve the spawn failure when removing the diagnostic file also fails.
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
        // The detached child may retain its inherited descriptor briefly.
      }
    },
  };
}

function compactOpenShellDiagnostic(output: string): string {
  return stripVTControlCharacters(output)
    .replace(/[^\p{L}\p{N}\s'"():;._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isSandboxCreatingHandoff(output: string, sandboxName: string): boolean {
  const escapedName = sandboxName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `sandbox ["']${escapedName}["'] is no longer ready \\(phase: creating\\); stopping service forward`,
    "iu",
  ).test(compactOpenShellDiagnostic(output));
}

function isForwardingAnnounced(output: string, target: ForwardServiceTarget): boolean {
  const expected =
    `Forwarding ${target.localHost}:${String(target.localPort)} - ` +
    `${target.targetHost}:${String(target.targetPort)} in sandbox ${target.sandboxName} via gRPC`;
  return compactOpenShellDiagnostic(output).includes(expected);
}

function classifyStartOutput(
  child: ForwardServiceChild,
  target: ForwardServiceTarget,
): { readonly category: string; readonly sandboxCreating: boolean } {
  const output = child.readOutput?.() ?? "";
  const sandboxCreating = isSandboxCreatingHandoff(output, target.sandboxName);
  return {
    category: sandboxCreating
      ? "sandbox-creating"
      : isForwardingAnnounced(output, target)
        ? "forwarding-announced"
        : output.trim()
          ? "non-readiness-diagnostic"
          : "empty-diagnostic",
    sandboxCreating,
  };
}

function isProcessId(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && Number(pid) > 0;
}

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

function isMissingProcessError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ESRCH";
}

function stopOwnedProcess(input: {
  readonly expectedIdentity: string | null | undefined;
  readonly isRunning: (pid: number) => boolean;
  readonly pid: number;
  readonly readIdentity: (pid: number) => string | null | undefined;
  readonly sleep: (milliseconds: number) => void;
  readonly stop: (pid: number, signal: NodeJS.Signals) => void;
  readonly timeoutMs: number;
}): "stopped" | "running" | "unverified" {
  if (!input.expectedIdentity) return "unverified";
  const waitForExit = (): "stopped" | "running" | "unverified" => {
    const deadline = Date.now() + input.timeoutMs;
    while (true) {
      const identity = processIdentityStatus(input.pid, input.expectedIdentity, input.readIdentity);
      if (identity === "exited" || !input.isRunning(input.pid)) return "stopped";
      if (identity === "unverified") return "unverified";
      if (Date.now() >= deadline) return "running";
      input.sleep(POLL_INTERVAL_MS);
    }
  };
  const initialIdentity = processIdentityStatus(
    input.pid,
    input.expectedIdentity,
    input.readIdentity,
  );
  if (initialIdentity === "exited") return "stopped";
  if (initialIdentity === "unverified") return "unverified";
  try {
    input.stop(input.pid, "SIGTERM");
  } catch (error) {
    return isMissingProcessError(error) ? "stopped" : "running";
  }
  const terminated = waitForExit();
  if (terminated !== "running") return terminated;
  if (processIdentityStatus(input.pid, input.expectedIdentity, input.readIdentity) !== "owned") {
    return "unverified";
  }
  try {
    input.stop(input.pid, "SIGKILL");
  } catch (error) {
    return isMissingProcessError(error) ? "stopped" : "running";
  }
  return waitForExit();
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

type ForwardAttemptResult = {
  readonly category: string;
  readonly processId: number;
  readonly sandboxCreating: boolean;
};

function startForwardServiceAttempt(input: {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly options: ForwardServiceLaunchOptions;
  readonly readyDeadline: number;
  readonly target: ForwardServiceTarget;
}): ForwardAttemptResult | null {
  const readIdentity = input.options.getProcessIdentity ?? getProcessIdentity;
  const observeListener = input.options.isListenerOwned
    ? (pid: number, port: number): ForwardListenerObservation => {
        const owned = input.options.isListenerOwned?.(pid, port);
        return owned === true ? "owned" : owned === false ? "absent" : "unavailable";
      }
    : process.platform === "linux"
      ? observeLinuxForwardListener
      : (pid: number, port: number): ForwardListenerObservation => {
          const owned = getForwardListenerOwnership(pid, port);
          return owned === true ? "owned" : owned === false ? "absent" : "unavailable";
        };
  const running = input.options.isProcessRunning ?? isProcessRunning;
  const sleep =
    input.options.sleep ??
    ((milliseconds: number) => Atomics.wait(sleepBuffer, 0, 0, milliseconds));
  const spawnDetached = input.options.spawnDetached ?? spawnForwardService;
  const stop =
    input.options.stopProcess ??
    ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const instanceId = randomUUID();
  const child = spawnDetached(input.target.executable, input.args, {
    ...input.environment,
    [FORWARD_INSTANCE_ENV]: instanceId,
  });
  if (!isProcessId(child.pid)) {
    const start = classifyStartOutput(child, input.target);
    child.removeOutput?.();
    throw new Error(
      `OpenShell forward service returned no process identity for ${input.target.localHost}:${String(input.target.localPort)}; refusing to start a duplicate service; forward start: ${start.category}`,
    );
  }
  const pid = child.pid;
  const expectedIdentity = input.options.getProcessIdentity
    ? readIdentity(pid)
    : process.platform === "linux"
      ? readIdentity(pid)
      : `${process.platform}:${instanceId}`;
  child.unref();
  let firstOwnedListenerAt: number | undefined;
  let listenerObservation: ForwardListenerObservation = "absent";

  while (true) {
    const identity = processIdentityStatus(pid, expectedIdentity, readIdentity);
    if (identity === "exited" || !running(pid)) {
      const start = classifyStartOutput(child, input.target);
      child.removeOutput?.();
      return { ...start, processId: pid };
    }
    if (identity === "unverified") {
      const start = classifyStartOutput(child, input.target);
      child.removeOutput?.();
      throw new Error(
        `OpenShell forward service process ${String(pid)} changed identity before binding ${input.target.localHost}:${String(input.target.localPort)}; refusing to signal or retry; forward start: ${start.category}`,
      );
    }
    listenerObservation = observeListener(pid, input.target.localPort);
    const now = Date.now();
    if (listenerObservation === "owned") {
      firstOwnedListenerAt ??= now;
      if (now - firstOwnedListenerAt >= LISTENER_RECHECK_DELAY_MS) {
        child.removeOutput?.();
        return null;
      }
    }
    const observationDeadline =
      firstOwnedListenerAt === undefined
        ? input.readyDeadline
        : Math.max(input.readyDeadline, firstOwnedListenerAt + LISTENER_RECHECK_DELAY_MS);
    if (now >= observationDeadline) {
      break;
    }
    sleep(POLL_INTERVAL_MS);
  }

  const stopped = stopOwnedProcess({
    expectedIdentity,
    isRunning: running,
    pid,
    readIdentity,
    sleep,
    stop,
    timeoutMs: input.options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
  });
  const start = classifyStartOutput(child, input.target);
  child.removeOutput?.();
  if (stopped !== "stopped") {
    throw new Error(
      `OpenShell forward service process ${String(pid)} did not become ready and ${stopped === "unverified" ? "could not be verified as owned" : "could not be stopped"}; refusing to retry; listener: ${listenerObservation}; forward start: ${start.category}`,
    );
  }
  const reachable = input.options.isReachable ?? probeLocalForwardListener;
  if (reachable(input.target.localPort)) {
    throw new Error(
      `Host port ${String(input.target.localPort)} remained reachable after the launched process stopped; refusing to adopt its listener or retry; listener: ${listenerObservation}; forward start: ${start.category}`,
    );
  }
  throw new Error(
    `OpenShell forward service did not become ready at ${input.target.localHost}:${String(input.target.localPort)}; listener: ${listenerObservation}; forward start: ${start.category}`,
  );
}

/** Launch one foreground OpenShell service forward as a detached host child. */
export function launchForwardService(
  target: ForwardServiceTarget,
  options: ForwardServiceLaunchOptions = {},
): void {
  validateForwardServiceTarget(target);
  const reachable = options.isReachable ?? probeLocalForwardListener;
  if (reachable(target.localPort)) {
    throw new Error(`Host port ${String(target.localPort)} is already occupied`);
  }
  const sleep =
    options.sleep ?? ((milliseconds: number) => Atomics.wait(sleepBuffer, 0, 0, milliseconds));
  const readyDeadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
  const maxRetries = options.maxSandboxCreatingRetries ?? SANDBOX_CREATING_MAX_RETRIES;
  if (
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > SANDBOX_CREATING_MAX_RETRIES
  ) {
    throw new Error(
      `OpenShell sandbox creating retries must be between 0 and ${String(SANDBOX_CREATING_MAX_RETRIES)}`,
    );
  }
  const args = buildForwardServiceArgs(target);
  const environment = buildOpenShellSubprocessEnv(options.sourceEnvironment ?? process.env);
  const evidence: string[] = [];
  let retries = 0;

  while (true) {
    if (retries > 0 && Date.now() >= readyDeadline) {
      throw new Error(
        `OpenShell forward service readiness budget expired before retry; attempts: ${evidence.join(", ")}`,
      );
    }
    if (retries > 0 && reachable(target.localPort)) {
      throw new Error(
        `Host port ${String(target.localPort)} became occupied before forward retry; refusing to adopt its listener; attempts: ${evidence.join(", ")}`,
      );
    }
    const result = startForwardServiceAttempt({
      args,
      environment,
      options,
      readyDeadline,
      target,
    });
    if (result === null) return;
    const attempt = retries + 1;
    evidence.push(`${String(attempt)}=pid-${String(result.processId)}:${result.category}`);
    const remainingMs = Math.max(0, readyDeadline - Date.now());
    if (
      !result.sandboxCreating ||
      retries >= maxRetries ||
      remainingMs < SANDBOX_CREATING_RETRY_INTERVAL_MS
    ) {
      throw new Error(
        `OpenShell forward service exited before binding ${target.localHost}:${String(target.localPort)}; attempts: ${evidence.join(", ")}`,
      );
    }
    retries += 1;
    const retryEvidence = {
      attempt,
      delayMs: SANDBOX_CREATING_RETRY_INTERVAL_MS,
      processId: result.processId,
      remainingMs,
    };
    if (options.onSandboxCreatingRetry) {
      options.onSandboxCreatingRetry(retryEvidence);
    } else {
      console.warn(
        `OpenShell ForwardTcp ${String(target.localPort)} start attempt ${String(attempt)} (pid ${String(result.processId)}) observed sandbox '${target.sandboxName}' in phase creating; retrying in ${String(SANDBOX_CREATING_RETRY_INTERVAL_MS)}ms with ${String(remainingMs)}ms remaining.`,
      );
    }
    sleep(SANDBOX_CREATING_RETRY_INTERVAL_MS);
  }
}
