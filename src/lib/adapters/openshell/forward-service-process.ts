// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

import {
  processIsAlive,
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
  readMcpLockProcessIdentity,
} from "../../state/mcp-lifecycle-lock-identity";
import {
  buildOpenShellSubprocessEnv,
  type OpenShellSubprocessRuntimeAuthority,
} from "./resolve-shared";
import {
  buildForwardServiceArgs,
  classifyForwardServiceReceipt,
  type ForwardServiceProcessObservation,
  type ForwardServiceReceipt,
  type ForwardServiceReceiptDisposition,
  type ForwardServiceTarget,
} from "./forward-service";
import {
  readForwardServiceReceipt,
  removeForwardServiceReceipt,
  writeForwardServiceReceipt,
  type ForwardServiceStateOptions,
} from "./forward-service-state";

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

interface SpawnedForwardService {
  readonly pid?: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

export interface ForwardServiceProcessDeps {
  readonly hostIdentity: string;
  readonly pidNamespaceIdentity: string | null;
  readonly isReachable: (port: number) => boolean;
  readonly processIsAlive: (pid: number) => boolean;
  readonly readProcessArgv: (pid: number) => readonly string[] | null;
  readonly readProcessIdentity: (pid: number, fresh?: boolean) => string | null;
  readonly readProcessUid: (pid: number) => number | null;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep: (milliseconds: number) => void;
  readonly spawnDetached: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => SpawnedForwardService;
  readonly now: () => string;
}

export interface ForwardServiceProcessOptions extends ForwardServiceStateOptions {
  readonly deps?: ForwardServiceProcessDeps;
  /** The lifecycle owner must serialize this sandbox before any process effect. */
  readonly runExclusive: <T>(operation: () => T) => T;
  readonly runtimeAuthority?: OpenShellSubprocessRuntimeAuthority;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function blockingSleep(milliseconds: number): void {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export interface ForwardServiceInspection {
  readonly disposition: ForwardServiceReceiptDisposition | "absent";
  readonly reachable: boolean;
  readonly receipt: ForwardServiceReceipt | null;
}

function readProcessArgv(pid: number): readonly string[] | null {
  if (process.platform === "linux") {
    try {
      const argv = fs
        .readFileSync(`/proc/${String(pid)}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean);
      return argv.length > 0 ? argv : null;
    } catch {
      return null;
    }
  }
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    env: buildOpenShellSubprocessEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
  const command = result.status === 0 ? result.stdout.trim() : "";
  return command && !/\s/u.test(command.split(/\s/u, 1)[0] ?? "") ? command.split(/\s+/u) : null;
}

function readProcessUid(pid: number): number | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "uid="], {
    encoding: "utf8",
    env: buildOpenShellSubprocessEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
  const value = result.status === 0 ? Number(result.stdout.trim()) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function probeLocalPort(port: number): boolean {
  const script =
    "const net=require('node:net');" +
    `const s=net.createConnection({host:'127.0.0.1',port:${String(port)}});` +
    "s.setTimeout(1000);" +
    "s.on('connect',()=>{s.destroy();process.exit(0)});" +
    "s.on('error',()=>process.exit(1));" +
    "s.on('timeout',()=>{s.destroy();process.exit(1)});";
  const result = spawnSync(process.execPath, ["-e", script], {
    env: buildOpenShellSubprocessEnv(),
    stdio: "ignore",
    timeout: 2_000,
  });
  return result.status === 0;
}

const DEFAULT_DEPS: ForwardServiceProcessDeps = {
  hostIdentity: readMcpLockHostIdentity(),
  pidNamespaceIdentity: readMcpLockPidNamespaceIdentity(),
  isReachable: probeLocalPort,
  processIsAlive,
  readProcessArgv,
  readProcessIdentity: readMcpLockProcessIdentity,
  readProcessUid,
  signalProcess: (pid, signal) => process.kill(pid, signal),
  sleep: blockingSleep,
  spawnDetached: (executable, args, environment) => {
    const child = spawn(executable, [...args], {
      detached: true,
      env: environment,
      stdio: "ignore",
    });
    return child;
  },
  now: () => new Date().toISOString(),
};

function stateOptions(options: ForwardServiceProcessOptions): ForwardServiceStateOptions {
  return {
    stateDirectory: options.stateDirectory,
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
  };
}

function processObservation(
  receipt: ForwardServiceReceipt,
  deps: ForwardServiceProcessDeps,
  fresh = false,
): ForwardServiceProcessObservation {
  const alive = deps.processIsAlive(receipt.pid);
  return {
    alive,
    uid: alive ? deps.readProcessUid(receipt.pid) : null,
    processIdentity: alive ? deps.readProcessIdentity(receipt.pid, fresh) : null,
    hostIdentity: deps.hostIdentity,
    pidNamespaceIdentity: deps.pidNamespaceIdentity,
    argv: alive ? deps.readProcessArgv(receipt.pid) : null,
  };
}

export function inspectForwardServiceProcess(
  target: ForwardServiceTarget,
  options: ForwardServiceProcessOptions,
): ForwardServiceInspection {
  const receipt = readForwardServiceReceipt(target, stateOptions(options));
  if (!receipt) return { disposition: "absent", reachable: false, receipt: null };
  const deps = options.deps ?? DEFAULT_DEPS;
  return {
    disposition: classifyForwardServiceReceipt(receipt, target, processObservation(receipt, deps)),
    reachable: deps.isReachable(target.localPort),
    receipt,
  };
}

function waitForProcessExit(
  receipt: ForwardServiceReceipt,
  deps: ForwardServiceProcessDeps,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!deps.processIsAlive(receipt.pid)) return true;
    const current = processObservation(receipt, deps, true);
    if (classifyForwardServiceReceipt(receipt, receipt, current) !== "owned") return false;
    deps.sleep(POLL_INTERVAL_MS);
  }
  return !deps.processIsAlive(receipt.pid);
}

function stopForwardServiceProcessUnlocked(
  target: ForwardServiceTarget,
  options: ForwardServiceProcessOptions,
): "absent" | "stopped" {
  const deps = options.deps ?? DEFAULT_DEPS;
  const inspection = inspectForwardServiceProcess(target, options);
  if (!inspection.receipt) return "absent";
  if (inspection.disposition === "stale" && !inspection.reachable) {
    if (removeForwardServiceReceipt(inspection.receipt, stateOptions(options)) === "changed") {
      throw new Error("OpenShell forward service receipt changed during stale cleanup");
    }
    return "absent";
  }
  if (inspection.disposition !== "owned") {
    throw new Error(
      `OpenShell forward service process is ${inspection.disposition}; refusing signal`,
    );
  }

  const confirmed = classifyForwardServiceReceipt(
    inspection.receipt,
    target,
    processObservation(inspection.receipt, deps, true),
  );
  if (confirmed !== "owned") {
    throw new Error("OpenShell forward service process identity changed before signal");
  }
  try {
    deps.signalProcess(inspection.receipt.pid, "SIGTERM");
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error;
  }
  if (
    !waitForProcessExit(inspection.receipt, deps, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
  ) {
    throw new Error("OpenShell forward service process did not stop after SIGTERM");
  }
  if (deps.isReachable(target.localPort)) {
    throw new Error("OpenShell forward service listener remained reachable after process exit");
  }
  const removed = removeForwardServiceReceipt(inspection.receipt, stateOptions(options));
  if (removed === "changed") {
    throw new Error("OpenShell forward service receipt changed during process cleanup");
  }
  return "stopped";
}

export function stopForwardServiceProcess(
  target: ForwardServiceTarget,
  options: ForwardServiceProcessOptions,
): "absent" | "stopped" {
  return options.runExclusive(() => stopForwardServiceProcessUnlocked(target, options));
}

function startedReceipt(
  target: ForwardServiceTarget,
  pid: number,
  deps: ForwardServiceProcessDeps,
  uid: number,
): ForwardServiceReceipt | null {
  const processIdentity = deps.readProcessIdentity(pid, true);
  const argv = deps.readProcessArgv(pid);
  const observedUid = deps.readProcessUid(pid);
  const expectedArgv = [target.executable, ...buildForwardServiceArgs(target)];
  if (
    !processIdentity ||
    !argv ||
    observedUid !== uid ||
    argv.length !== expectedArgv.length ||
    argv.some((value, index) => value !== expectedArgv[index])
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    ...target,
    pid,
    uid,
    processIdentity,
    hostIdentity: deps.hostIdentity,
    pidNamespaceIdentity: deps.pidNamespaceIdentity,
    argv,
    startedAt: deps.now(),
  };
}

export function ensureForwardServiceProcess(
  target: ForwardServiceTarget,
  options: ForwardServiceProcessOptions,
): { readonly action: "reused" | "started"; readonly receipt: ForwardServiceReceipt } {
  return options.runExclusive(() => {
    const deps = options.deps ?? DEFAULT_DEPS;
    const current = inspectForwardServiceProcess(target, options);
    if (current.disposition === "owned" && current.reachable && current.receipt) {
      return { action: "reused", receipt: current.receipt };
    }
    if (current.disposition === "owned") {
      stopForwardServiceProcessUnlocked(target, options);
    } else if (current.disposition === "stale" && current.receipt && !current.reachable) {
      if (removeForwardServiceReceipt(current.receipt, stateOptions(options)) === "changed") {
        throw new Error("OpenShell forward service receipt changed before start");
      }
    } else if (current.disposition !== "absent") {
      throw new Error(`OpenShell forward service state is ${current.disposition}; refusing start`);
    }
    if (deps.isReachable(target.localPort)) {
      throw new Error("OpenShell forward service local port is owned by another listener");
    }

    const uid = options.uid ?? process.getuid?.();
    if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
      throw new Error("OpenShell forward service process requires a current-user identity");
    }
    const args = buildForwardServiceArgs(target);
    const child = deps.spawnDetached(
      target.executable,
      args,
      buildOpenShellSubprocessEnv(
        options.sourceEnvironment ?? process.env,
        options.runtimeAuthority,
      ),
    );
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
      child.kill("SIGTERM");
      throw new Error("OpenShell forward service process did not publish a PID");
    }
    child.unref();

    const deadline = Date.now() + (options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let receipt: ForwardServiceReceipt | null = null;
    let observedReceipt: ForwardServiceReceipt | null = null;
    while (Date.now() < deadline) {
      if (!deps.processIsAlive(Number(pid))) break;
      observedReceipt = startedReceipt(target, Number(pid), deps, Number(uid));
      if (observedReceipt && deps.isReachable(target.localPort)) {
        receipt = observedReceipt;
        break;
      }
      deps.sleep(POLL_INTERVAL_MS);
    }
    if (!receipt) {
      child.kill("SIGTERM");
      if (
        observedReceipt &&
        !waitForProcessExit(observedReceipt, deps, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
      ) {
        writeForwardServiceReceipt(observedReceipt, stateOptions(options));
        throw new Error(
          "OpenShell forward service process did not become ready and remains running",
        );
      }
      throw new Error("OpenShell forward service process did not become ready");
    }
    try {
      writeForwardServiceReceipt(receipt, stateOptions(options));
      const verified = inspectForwardServiceProcess(target, options);
      if (verified.disposition !== "owned" || !verified.reachable) {
        throw new Error("OpenShell forward service process changed during publication");
      }
    } catch (error) {
      child.kill("SIGTERM");
      if (waitForProcessExit(receipt, deps, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)) {
        removeForwardServiceReceipt(receipt, stateOptions(options));
      }
      throw error;
    }
    return { action: "started", receipt };
  });
}
