// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

import { parseForwardList } from "../../../state/sandbox-session";
import { classifySandboxForwardHealth, isLocalForwardReachable } from "../forward-health";

const FORWARD_SETTLEMENT_TIMEOUT_MS = 3_000;
const FORWARD_SETTLEMENT_INTERVAL_MS = 100;
const FORWARD_SETTLEMENT_MAX_OBSERVATIONS =
  Math.ceil(FORWARD_SETTLEMENT_TIMEOUT_MS / FORWARD_SETTLEMENT_INTERVAL_MS) + 2;

type CommandResult = {
  readonly error?: unknown;
  readonly output?: string | null;
  readonly status?: number | null;
};

type ForwardState = "healthy" | "missing" | "occupied";

export type HermesPortableForwardRecoveryFailure =
  | "authority-drift"
  | "forward-occupied"
  | "forward-state-unavailable"
  | "recovery-failed"
  | "restoration-unproved";

export class HermesPortableForwardRecoveryError extends Error {
  constructor(readonly failure: HermesPortableForwardRecoveryFailure) {
    super(`Hermes Portable forward recovery failed: ${failure}`);
  }
}

export interface HermesPortableForwardRecoveryDeps {
  readonly assertCurrent: () => void;
  readonly assertRollbackCurrent: () => void;
  readonly captureCurrent: (args: readonly string[], timeout: number) => CommandResult;
  readonly captureRollback: (args: readonly string[], timeout: number) => CommandResult;
  readonly isPortReachable?: (port: number) => boolean;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
}

export interface HermesPortableForwardRecoveryInput {
  readonly intent: "connect-probe-only";
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly operationTimeoutMs: number;
  readonly ports: readonly number[];
  readonly probeTimeoutMs: number;
  readonly deps: HermesPortableForwardRecoveryDeps;
}

export type HermesPortableForwardRecoveryResult = {
  readonly kind: "restored" | "verified";
  readonly restoredPorts: readonly number[];
};

function failure(failureClass: HermesPortableForwardRecoveryFailure): never {
  throw new HermesPortableForwardRecoveryError(failureClass);
}

function normalizeFailure(error: unknown): HermesPortableForwardRecoveryError {
  return error instanceof HermesPortableForwardRecoveryError
    ? error
    : new HermesPortableForwardRecoveryError("recovery-failed");
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function isSupportedBind(value: string): boolean {
  if (value === "*") return true;
  const candidate = /^\[[^\]]+\]$/u.test(value) ? value.slice(1, -1) : value;
  return isIP(candidate) !== 0;
}

function isSupportedForwardRow(parts: readonly string[]): boolean {
  if (parts.length !== 5) return false;
  const [sandboxName, bind, portValue, pidValue, status] = parts;
  const port = Number(portValue);
  const pid = Number(pidValue);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sandboxName) &&
    isSupportedBind(bind) &&
    /^\d+$/u.test(portValue) &&
    Number.isSafeInteger(port) &&
    port >= 1 &&
    port <= 65_535 &&
    /^\d+$/u.test(pidValue) &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    ["running", "stopped"].includes(status.toLowerCase())
  );
}

function parseStrictForwardList(output: unknown) {
  if (typeof output !== "string") return null;
  const lines = stripAnsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || !/^SANDBOX\s+BIND\s+PORT\s+PID\s+STATUS$/iu.test(lines[0])) {
    return null;
  }
  if (lines.slice(1).some((line) => !isSupportedForwardRow(line.split(/\s+/u)))) {
    return null;
  }
  return parseForwardList(lines.join("\n"));
}

function requireCurrent(input: HermesPortableForwardRecoveryInput, rollback: boolean): void {
  try {
    if (rollback) input.deps.assertRollbackCurrent();
    else input.deps.assertCurrent();
  } catch {
    failure(rollback ? "restoration-unproved" : "authority-drift");
  }
}

function captureForwardEntries(input: HermesPortableForwardRecoveryInput, rollback: boolean) {
  requireCurrent(input, rollback);
  let result: CommandResult;
  try {
    const capture = rollback ? input.deps.captureRollback : input.deps.captureCurrent;
    result = capture(["forward", "list", "--gateway", input.gatewayName], input.probeTimeoutMs);
  } catch (error) {
    if (error instanceof HermesPortableForwardRecoveryError) throw error;
    failure(rollback ? "restoration-unproved" : "forward-state-unavailable");
  }
  requireCurrent(input, rollback);
  if (result.error || result.status !== 0) {
    failure(rollback ? "restoration-unproved" : "forward-state-unavailable");
  }
  const entries = parseStrictForwardList(result.output);
  if (!entries) failure(rollback ? "restoration-unproved" : "forward-state-unavailable");
  return entries;
}

function observeForwards(
  input: HermesPortableForwardRecoveryInput,
  rollback: boolean,
): Map<number, ForwardState> {
  const entries = captureForwardEntries(input, rollback);
  const states = new Map<number, ForwardState>();
  const reachable = input.deps.isPortReachable ?? isLocalForwardReachable;
  for (const port of input.ports) {
    const portEntries = entries.filter((entry) => entry.port === String(port));
    if (portEntries.length > 1) {
      failure(rollback ? "restoration-unproved" : "forward-state-unavailable");
    }
    const ownership = classifySandboxForwardHealth(entries, input.sandboxName, String(port));
    if (ownership === "occupied") {
      states.set(port, "occupied");
      continue;
    }
    requireCurrent(input, rollback);
    let portReachable: boolean;
    try {
      portReachable = reachable(port);
    } catch {
      failure(rollback ? "restoration-unproved" : "forward-state-unavailable");
    }
    requireCurrent(input, rollback);
    states.set(
      port,
      ownership === true && portReachable
        ? "healthy"
        : ownership === false && portReachable
          ? "occupied"
          : "missing",
    );
  }
  return states;
}

function validatePorts(input: HermesPortableForwardRecoveryInput): void {
  if (
    input.intent !== "connect-probe-only" ||
    !Number.isFinite(input.operationTimeoutMs) ||
    input.operationTimeoutMs <= 0 ||
    input.ports.length === 0 ||
    !Number.isFinite(input.probeTimeoutMs) ||
    input.probeTimeoutMs <= 0 ||
    new Set(input.ports).size !== input.ports.length ||
    input.ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65_535)
  ) {
    failure("forward-state-unavailable");
  }
}

function requireNoOccupied(states: Map<number, ForwardState>): void {
  if ([...states.values()].includes("occupied")) failure("forward-occupied");
}

function invokeMutation(input: HermesPortableForwardRecoveryInput, args: readonly string[]): void {
  requireCurrent(input, false);
  try {
    input.deps.captureCurrent(args, input.operationTimeoutMs);
  } catch (error) {
    throw normalizeFailure(error);
  }
  requireCurrent(input, false);
}

function readClock(now: () => number, previous?: number): number {
  const current = now();
  if (!Number.isFinite(current) || (previous !== undefined && current < previous)) {
    failure("recovery-failed");
  }
  return current;
}

function settleStartedPort(
  input: HermesPortableForwardRecoveryInput,
  port: number,
  requiredHealthy: ReadonlySet<number>,
): void {
  const now = input.deps.now ?? Date.now;
  const sleep = input.deps.sleep ?? sleepMilliseconds;
  let previous = readClock(now);
  const deadline = previous + FORWARD_SETTLEMENT_TIMEOUT_MS;
  if (!Number.isFinite(deadline)) failure("recovery-failed");

  for (let observation = 0; observation < FORWARD_SETTLEMENT_MAX_OBSERVATIONS; observation += 1) {
    const states = observeForwards(input, false);
    requireNoOccupied(states);
    if ([...requiredHealthy].some((requiredPort) => states.get(requiredPort) !== "healthy")) {
      failure("recovery-failed");
    }
    if (states.get(port) === "healthy") return;

    const current = readClock(now, previous);
    previous = current;
    if (current >= deadline) break;
    sleep(Math.min(FORWARD_SETTLEMENT_INTERVAL_MS, deadline - current));
  }
  failure("recovery-failed");
}

function rollbackPort(input: HermesPortableForwardRecoveryInput, port: number): void {
  try {
    requireCurrent(input, true);
    input.deps.captureRollback(
      ["forward", "stop", String(port), input.sandboxName, "--gateway", input.gatewayName],
      input.operationTimeoutMs,
    );
    requireCurrent(input, true);
  } catch {
    failure("restoration-unproved");
  }

  const now = input.deps.now ?? Date.now;
  const sleep = input.deps.sleep ?? sleepMilliseconds;
  let previous = readClock(now);
  const deadline = previous + FORWARD_SETTLEMENT_TIMEOUT_MS;
  if (!Number.isFinite(deadline)) failure("restoration-unproved");
  for (let observation = 0; observation < FORWARD_SETTLEMENT_MAX_OBSERVATIONS; observation += 1) {
    let state: ForwardState | undefined;
    try {
      state = observeForwards(input, true).get(port);
    } catch {
      failure("restoration-unproved");
    }
    if (state === "missing") return;
    if (state === "occupied") failure("restoration-unproved");
    const current = readClock(now, previous);
    previous = current;
    if (current >= deadline) break;
    sleep(Math.min(FORWARD_SETTLEMENT_INTERVAL_MS, deadline - current));
  }
  failure("restoration-unproved");
}

function rollbackTouchedPorts(
  input: HermesPortableForwardRecoveryInput,
  touchedPorts: readonly number[],
): void {
  for (const port of [...touchedPorts].reverse()) rollbackPort(input, port);
}

/** Restore the exact launch-readiness forward set for one Hermes probe. */
export function recoverHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): HermesPortableForwardRecoveryResult {
  validatePorts(input);
  const touchedPorts: number[] = [];
  try {
    const initial = observeForwards(input, false);
    requireNoOccupied(initial);
    const missing = input.ports.filter((port) => initial.get(port) !== "healthy");
    if (missing.length === 0) {
      requireCurrent(input, false);
      return { kind: "verified", restoredPorts: [] };
    }

    const requiredHealthy = new Set(input.ports.filter((port) => initial.get(port) === "healthy"));
    for (const port of missing) {
      touchedPorts.push(port);
      invokeMutation(input, [
        "forward",
        "stop",
        String(port),
        input.sandboxName,
        "--gateway",
        input.gatewayName,
      ]);
      invokeMutation(input, [
        "forward",
        "start",
        "--background",
        String(port),
        input.sandboxName,
        "--gateway",
        input.gatewayName,
      ]);
      settleStartedPort(input, port, requiredHealthy);
      requiredHealthy.add(port);
    }

    const final = observeForwards(input, false);
    requireNoOccupied(final);
    if (input.ports.some((port) => final.get(port) !== "healthy")) {
      failure("recovery-failed");
    }
    requireCurrent(input, false);
    return { kind: "restored", restoredPorts: [...missing] };
  } catch (error) {
    if (touchedPorts.length > 0) {
      try {
        rollbackTouchedPorts(input, touchedPorts);
      } catch {
        failure("restoration-unproved");
      }
    }
    throw normalizeFailure(error);
  }
}

function sleepMilliseconds(milliseconds: number): void {
  if (milliseconds <= 0 || !Number.isFinite(milliseconds)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
