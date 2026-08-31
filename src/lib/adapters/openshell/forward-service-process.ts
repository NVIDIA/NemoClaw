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
  type ForwardServicePendingReceipt,
  type ForwardServiceReceipt,
  type ForwardServiceReceiptDisposition,
  type ForwardServiceTarget,
} from "./forward-service";
import {
  readForwardServiceReceipt,
  readForwardServicePendingReceipt,
  removeForwardServicePendingReceipt,
  removeForwardServiceReceipt,
  writeForwardServicePendingReceipt,
  writeForwardServiceReceipt,
  type ForwardServiceStateOptions,
} from "./forward-service-state";
import { probeLocalForwardListener } from "./local-forward-listener";

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
  readonly processOwnsListener: (pid: number, target: ForwardServiceTarget) => boolean | null;
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
  readonly ownsListener: boolean | null;
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

function linuxProcessOwnsListener(pid: number, target: ForwardServiceTarget): boolean | null {
  try {
    const socketInodes = new Set(
      fs
        .readdirSync(`/proc/${String(pid)}/fd`)
        .map((entry) => {
          try {
            return /^socket:\[([0-9]+)\]$/u.exec(
              fs.readlinkSync(`/proc/${String(pid)}/fd/${entry}`),
            )?.[1];
          } catch {
            return undefined;
          }
        })
        .filter((entry): entry is string => entry !== undefined),
    );
    if (socketInodes.size === 0) return false;
    const expectedAddress = target.localHost === "0.0.0.0" ? "00000000" : "0100007F";
    const expectedPort = target.localPort.toString(16).toUpperCase().padStart(4, "0");
    for (const line of fs
      .readFileSync(`/proc/${String(pid)}/net/tcp`, "utf8")
      .split("\n")
      .slice(1)) {
      const columns = line.trim().split(/\s+/u);
      const [address, port] = (columns[1] ?? "").split(":");
      if (
        address === expectedAddress &&
        port === expectedPort &&
        columns[3] === "0A" &&
        socketInodes.has(columns[9] ?? "")
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}

function darwinProcessOwnsListener(pid: number, target: ForwardServiceTarget): boolean | null {
  const result = spawnSync(
    "lsof",
    ["-nP", "-a", "-p", String(pid), `-iTCP:${String(target.localPort)}`, "-sTCP:LISTEN", "-Fn"],
    {
      encoding: "utf8",
      env: buildOpenShellSubprocessEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    },
  );
  if (result.error) return null;
  if (result.status === 1) return false;
  if (result.status !== 0) return null;
  const expected =
    target.localHost === "0.0.0.0"
      ? new Set([`n*:${String(target.localPort)}`, `n0.0.0.0:${String(target.localPort)}`])
      : new Set([`n127.0.0.1:${String(target.localPort)}`]);
  return result.stdout.split("\n").some((line) => expected.has(line.trim()));
}

export function processOwnsForwardServiceListener(
  pid: number,
  target: ForwardServiceTarget,
): boolean | null {
  if (process.platform === "linux") return linuxProcessOwnsListener(pid, target);
  if (process.platform === "darwin") return darwinProcessOwnsListener(pid, target);
  return null;
}

const DEFAULT_DEPS: ForwardServiceProcessDeps = {
  hostIdentity: readMcpLockHostIdentity(),
  pidNamespaceIdentity: readMcpLockPidNamespaceIdentity(),
  isReachable: probeLocalForwardListener,
  processIsAlive,
  processOwnsListener: processOwnsForwardServiceListener,
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

function pendingDisposition(
  pending: ForwardServicePendingReceipt,
  deps: ForwardServiceProcessDeps,
): ForwardServiceReceiptDisposition {
  if (
    pending.hostIdentity !== deps.hostIdentity ||
    pending.pidNamespaceIdentity !== deps.pidNamespaceIdentity
  ) {
    return "foreign";
  }
  return deps.processIsAlive(pending.pid) ? "unknown" : "stale";
}

function pendingMatchesCompleted(
  pending: ForwardServicePendingReceipt,
  completed: ForwardServiceReceipt,
): boolean {
  return (
    pending.pid === completed.pid &&
    pending.launcherUid === completed.uid &&
    pending.hostIdentity === completed.hostIdentity &&
    pending.pidNamespaceIdentity === completed.pidNamespaceIdentity &&
    pending.executable === completed.executable &&
    pending.gatewayName === completed.gatewayName &&
    pending.sandboxName === completed.sandboxName &&
    pending.sandboxIdentityFingerprint === completed.sandboxIdentityFingerprint &&
    pending.localHost === completed.localHost &&
    pending.localPort === completed.localPort &&
    pending.targetHost === completed.targetHost &&
    pending.targetPort === completed.targetPort &&
    pending.expectedArgv.length === completed.argv.length &&
    pending.expectedArgv.every((value, index) => value === completed.argv[index])
  );
}

export function inspectForwardServiceProcess(
  target: ForwardServiceTarget,
  options: ForwardServiceProcessOptions,
): ForwardServiceInspection {
  const receipt = readForwardServiceReceipt(target, stateOptions(options));
  if (!receipt) {
    const deps = options.deps ?? DEFAULT_DEPS;
    const pending = readForwardServicePendingReceipt(target, stateOptions(options));
    return pending
      ? {
          disposition: pendingDisposition(pending, deps),
          ownsListener: null,
          reachable: deps.isReachable(target.localPort),
          receipt: null,
        }
      : { disposition: "absent", ownsListener: false, reachable: false, receipt: null };
  }
  const deps = options.deps ?? DEFAULT_DEPS;
  const observation = processObservation(receipt, deps);
  const disposition = classifyForwardServiceReceipt(receipt, target, observation);
  return {
    disposition,
    ownsListener: disposition === "owned" ? deps.processOwnsListener(receipt.pid, target) : false,
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
  const pending = readForwardServicePendingReceipt(target, stateOptions(options));
  if (pending) {
    const completed = readForwardServiceReceipt(target, stateOptions(options));
    const disposition = pendingDisposition(pending, deps);
    if (completed && pendingMatchesCompleted(pending, completed)) {
      if (removeForwardServicePendingReceipt(pending, stateOptions(options)) !== "removed") {
        throw new Error("OpenShell forward service pending receipt changed during reconciliation");
      }
    } else if (disposition !== "stale") {
      throw new Error(
        `OpenShell forward service pending process is ${disposition}; refusing signal`,
      );
    } else if (removeForwardServicePendingReceipt(pending, stateOptions(options)) !== "removed") {
      throw new Error("OpenShell forward service pending receipt changed during cleanup");
    }
  }
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

function pendingReceipt(
  target: ForwardServiceTarget,
  pid: number,
  deps: ForwardServiceProcessDeps,
  uid: number,
): ForwardServicePendingReceipt {
  return {
    pendingSchemaVersion: 1,
    ...target,
    pid,
    launcherUid: uid,
    hostIdentity: deps.hostIdentity,
    pidNamespaceIdentity: deps.pidNamespaceIdentity,
    expectedArgv: [target.executable, ...buildForwardServiceArgs(target)],
    startedAt: deps.now(),
  };
}

function waitForUnidentifiedProcessExit(
  pid: number,
  deps: ForwardServiceProcessDeps,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!deps.processIsAlive(pid)) return true;
    deps.sleep(POLL_INTERVAL_MS);
  }
  return !deps.processIsAlive(pid);
}

export function ensureForwardServiceProcess(
  target: ForwardServiceTarget,
  options: ForwardServiceProcessOptions,
): { readonly action: "reused" | "started"; readonly receipt: ForwardServiceReceipt } {
  return options.runExclusive(() => {
    const deps = options.deps ?? DEFAULT_DEPS;
    const existingPending = readForwardServicePendingReceipt(target, stateOptions(options));
    if (existingPending) {
      const completed = readForwardServiceReceipt(target, stateOptions(options));
      const disposition = pendingDisposition(existingPending, deps);
      if (completed && pendingMatchesCompleted(existingPending, completed)) {
        if (
          removeForwardServicePendingReceipt(existingPending, stateOptions(options)) !== "removed"
        ) {
          throw new Error(
            "OpenShell forward service pending receipt changed during reconciliation",
          );
        }
      } else if (disposition !== "stale") {
        throw new Error(`OpenShell forward service pending process is ${disposition}`);
      } else if (
        removeForwardServicePendingReceipt(existingPending, stateOptions(options)) !== "removed"
      ) {
        throw new Error("OpenShell forward service pending receipt changed before start");
      }
    }
    const current = inspectForwardServiceProcess(target, options);
    if (
      current.disposition === "owned" &&
      current.ownsListener === true &&
      current.reachable &&
      current.receipt
    ) {
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
    const launchedPending = pendingReceipt(target, Number(pid), deps, Number(uid));
    try {
      writeForwardServicePendingReceipt(launchedPending, stateOptions(options));
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
    child.unref();

    const deadline = Date.now() + (options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let receipt: ForwardServiceReceipt | null = null;
    let observedReceipt: ForwardServiceReceipt | null = null;
    while (Date.now() < deadline) {
      if (!deps.processIsAlive(Number(pid))) break;
      observedReceipt = startedReceipt(target, Number(pid), deps, Number(uid));
      if (
        observedReceipt &&
        deps.processOwnsListener(Number(pid), target) === true &&
        deps.isReachable(target.localPort)
      ) {
        receipt = observedReceipt;
        break;
      }
      deps.sleep(POLL_INTERVAL_MS);
    }
    if (!receipt) {
      child.kill("SIGTERM");
      const stopped = observedReceipt
        ? waitForProcessExit(
            observedReceipt,
            deps,
            options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
          )
        : waitForUnidentifiedProcessExit(
            Number(pid),
            deps,
            options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
          );
      if (!stopped) {
        if (observedReceipt) {
          writeForwardServiceReceipt(observedReceipt, stateOptions(options));
          if (
            removeForwardServicePendingReceipt(launchedPending, stateOptions(options)) !== "removed"
          ) {
            throw new Error(
              "OpenShell forward service pending receipt changed during failed-start publication",
            );
          }
        }
        throw new Error(
          "OpenShell forward service process did not become ready and remains running",
        );
      }
      if (
        removeForwardServicePendingReceipt(launchedPending, stateOptions(options)) !== "removed"
      ) {
        throw new Error("OpenShell forward service pending receipt changed after failed start");
      }
      throw new Error("OpenShell forward service process did not become ready");
    }
    try {
      writeForwardServiceReceipt(receipt, stateOptions(options));
      const pendingRemoved = removeForwardServicePendingReceipt(
        launchedPending,
        stateOptions(options),
      );
      if (pendingRemoved !== "removed") {
        throw new Error("OpenShell forward service pending receipt changed during publication");
      }
      const verified = inspectForwardServiceProcess(target, options);
      if (
        verified.disposition !== "owned" ||
        verified.ownsListener !== true ||
        !verified.reachable
      ) {
        throw new Error("OpenShell forward service process changed during publication");
      }
    } catch (error) {
      child.kill("SIGTERM");
      if (waitForProcessExit(receipt, deps, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)) {
        removeForwardServiceReceipt(receipt, stateOptions(options));
        removeForwardServicePendingReceipt(launchedPending, stateOptions(options));
      }
      throw error;
    }
    return { action: "started", receipt };
  });
}
