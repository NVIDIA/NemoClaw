// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

import { parseForwardList } from "../../../state/sandbox-session";
import { isLiveSandboxForwardStatus, isLocalForwardReachable } from "../forward-health";

const FORWARD_SETTLEMENT_TIMEOUT_MS = 3_000;
const FORWARD_SETTLEMENT_INTERVAL_MS = 100;
const FORWARD_SETTLEMENT_MAX_OBSERVATIONS =
  Math.ceil(FORWARD_SETTLEMENT_TIMEOUT_MS / FORWARD_SETTLEMENT_INTERVAL_MS) + 2;

type CommandResult = {
  readonly error?: unknown;
  readonly output?: string | null;
  readonly status?: number | null;
};

type ForwardState =
  | "absent"
  | "healthy"
  | "occupied"
  | "stale-reachable"
  | "stale-unreachable";
type ForwardTimingStage = "list" | "settle" | "start" | "stop";

export interface HermesPortableForwardRecoveryTimingEvidence {
  readonly listMs: number;
  readonly listCount: number;
  readonly stopMs: number;
  readonly stopCount: number;
  readonly startMs: number;
  readonly startCount: number;
  readonly settleMs: number;
  readonly settleCount: number;
  readonly totalMs: number;
  readonly result: "proved" | "failed";
}

export interface HermesPortableForwardRecoveryTiming {
  readonly now?: () => number;
  readonly onComplete: (evidence: HermesPortableForwardRecoveryTimingEvidence) => void;
}

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
  readonly captureCurrentList: (args: readonly string[], timeout: number) => CommandResult;
  readonly captureRollbackList: (args: readonly string[], timeout: number) => CommandResult;
  readonly runCurrentMutation: (args: readonly string[], timeout: number) => unknown;
  readonly runRollbackMutation: (args: readonly string[], timeout: number) => unknown;
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
  readonly timing?: HermesPortableForwardRecoveryTiming;
}

export type HermesPortableForwardRecoveryResult = {
  readonly kind: "restored" | "verified";
  readonly restoredPorts: readonly number[];
};

export type HermesPortableForwardVerificationResult = {
  readonly kind: "healthy" | "unhealthy";
};

export interface PreparedHermesPortableForwardRecovery {
  readonly result: HermesPortableForwardRecoveryResult;
  readonly release: () => HermesPortableForwardRecoveryResult;
  readonly rollback: () => void;
}

function failure(failureClass: HermesPortableForwardRecoveryFailure): never {
  throw new HermesPortableForwardRecoveryError(failureClass);
}

function normalizeFailure(error: unknown): HermesPortableForwardRecoveryError {
  return error instanceof HermesPortableForwardRecoveryError
    ? error
    : new HermesPortableForwardRecoveryError("recovery-failed");
}

function safeTimingNow(now: () => number): number | null {
  try {
    const value = now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function createForwardTimingRecorder(timing?: HermesPortableForwardRecoveryTiming): {
  readonly finish: (result: HermesPortableForwardRecoveryTimingEvidence["result"]) => void;
  readonly measure: <T>(stage: ForwardTimingStage, operation: () => T) => T;
} {
  const now = timing?.now ?? (() => performance.now());
  const startedAt = safeTimingNow(now);
  const durations = new Map<ForwardTimingStage, number>();
  const counts = new Map<ForwardTimingStage, number>();
  let finished = false;
  const elapsed = (start: number | null, end: number | null): number => {
    if (start === null || end === null) return 0;
    const value = Math.round(end - start);
    return Number.isFinite(value) ? Math.min(9_999_999, Math.max(0, value)) : 0;
  };
  return Object.freeze({
    measure<T>(stage: ForwardTimingStage, operation: () => T): T {
      const stageStartedAt = safeTimingNow(now);
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
      try {
        return operation();
      } finally {
        durations.set(
          stage,
          Math.min(
            9_999_999,
            (durations.get(stage) ?? 0) + elapsed(stageStartedAt, safeTimingNow(now)),
          ),
        );
      }
    },
    finish(result): void {
      if (finished) return;
      finished = true;
      if (!timing) return;
      try {
        timing.onComplete(
          Object.freeze({
            listMs: durations.get("list") ?? 0,
            listCount: counts.get("list") ?? 0,
            stopMs: durations.get("stop") ?? 0,
            stopCount: counts.get("stop") ?? 0,
            startMs: durations.get("start") ?? 0,
            startCount: counts.get("start") ?? 0,
            settleMs: durations.get("settle") ?? 0,
            settleCount: counts.get("settle") ?? 0,
            totalMs: elapsed(startedAt, safeTimingNow(now)),
            result,
          }),
        );
      } catch {
        // Timing output must not change forward recovery.
      }
    },
  });
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
    (isLiveSandboxForwardStatus(status.toLowerCase()) ||
      ["dead", "stopped"].includes(status.toLowerCase()))
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

function captureForwardEntries(
  input: HermesPortableForwardRecoveryInput,
  rollback: boolean,
  timing?: ReturnType<typeof createForwardTimingRecorder>,
) {
  requireCurrent(input, rollback);
  let result: CommandResult;
  try {
    const capture = rollback ? input.deps.captureRollbackList : input.deps.captureCurrentList;
    const operation = () =>
      capture(["forward", "list", "--gateway", input.gatewayName], input.probeTimeoutMs);
    result = timing ? timing.measure("list", operation) : operation();
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
  timing?: ReturnType<typeof createForwardTimingRecorder>,
): Map<number, ForwardState> {
  const entries = captureForwardEntries(input, rollback, timing);
  const states = new Map<number, ForwardState>();
  const reachable = input.deps.isPortReachable ?? isLocalForwardReachable;
  for (const port of input.ports) {
    const portEntries = entries.filter((entry) => entry.port === String(port));
    if (portEntries.some((entry) => entry.sandboxName !== input.sandboxName)) {
      states.set(port, "occupied");
      continue;
    }
    if (portEntries.length > 1) {
      failure(rollback ? "restoration-unproved" : "forward-state-unavailable");
    }
    const entry = portEntries[0];
    requireCurrent(input, rollback);
    let portReachable: boolean;
    try {
      portReachable = reachable(port);
    } catch {
      failure(rollback ? "restoration-unproved" : "forward-state-unavailable");
    }
    requireCurrent(input, rollback);
    if (entry) {
      states.set(
        port,
        isLiveSandboxForwardStatus(entry.status) && portReachable
          ? "healthy"
          : portReachable
            ? "stale-reachable"
            : "stale-unreachable",
      );
    } else {
      states.set(port, portReachable ? "occupied" : "absent");
    }
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

function invokeMutation(
  input: HermesPortableForwardRecoveryInput,
  stage: "start" | "stop",
  args: readonly string[],
  timing: ReturnType<typeof createForwardTimingRecorder>,
): void {
  requireCurrent(input, false);
  try {
    timing.measure(stage, () => input.deps.runCurrentMutation(args, input.operationTimeoutMs));
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
  timing: ReturnType<typeof createForwardTimingRecorder>,
): Map<number, ForwardState> {
  return timing.measure("settle", () => {
    const now = input.deps.now ?? Date.now;
    const sleep = input.deps.sleep ?? sleepMilliseconds;
    let previous = readClock(now);
    const deadline = previous + FORWARD_SETTLEMENT_TIMEOUT_MS;
    if (!Number.isFinite(deadline)) failure("recovery-failed");

    for (let observation = 0; observation < FORWARD_SETTLEMENT_MAX_OBSERVATIONS; observation += 1) {
      const states = observeForwards(input, false, timing);
      requireNoOccupied(states);
      if ([...requiredHealthy].some((requiredPort) => states.get(requiredPort) !== "healthy")) {
        failure("recovery-failed");
      }
      if (states.get(port) === "healthy") return states;

      const current = readClock(now, previous);
      previous = current;
      if (current >= deadline) break;
      sleep(Math.min(FORWARD_SETTLEMENT_INTERVAL_MS, deadline - current));
    }
    failure("recovery-failed");
  });
}

function rollbackPort(input: HermesPortableForwardRecoveryInput, port: number): void {
  try {
    requireCurrent(input, true);
    input.deps.runRollbackMutation(
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
    if (state === "absent" || state === "stale-unreachable") return;
    if (state === "occupied" || state === "stale-reachable") {
      failure("restoration-unproved");
    }
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

function retainForwardRecovery(
  input: HermesPortableForwardRecoveryInput,
  touchedPorts: readonly number[],
  result: HermesPortableForwardRecoveryResult,
): PreparedHermesPortableForwardRecovery {
  let state: "prepared" | "released" | "rolled-back" = "prepared";
  return Object.freeze({
    result,
    release: () => {
      if (state !== "prepared") failure("recovery-failed");
      state = "released";
      return result;
    },
    rollback: () => {
      if (state !== "prepared") failure("restoration-unproved");
      state = "rolled-back";
      if (touchedPorts.length > 0) rollbackTouchedPorts(input, touchedPorts);
    },
  });
}

/** Prepare the exact launch-readiness forward set while retaining rollback authority. */
export function prepareHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): PreparedHermesPortableForwardRecovery {
  const timing = createForwardTimingRecorder(input.timing);
  const touchedPorts: number[] = [];
  try {
    validatePorts(input);
    const initial = observeForwards(input, false, timing);
    requireNoOccupied(initial);
    const missing = input.ports.filter((port) => initial.get(port) !== "healthy");
    if (missing.length === 0) {
      requireCurrent(input, false);
      timing.finish("proved");
      return retainForwardRecovery(input, touchedPorts, { kind: "verified", restoredPorts: [] });
    }

    const requiredHealthy = new Set(input.ports.filter((port) => initial.get(port) === "healthy"));
    let final = initial;
    for (const port of missing) {
      touchedPorts.push(port);
      if (["stale-reachable", "stale-unreachable"].includes(initial.get(port) ?? "")) {
        invokeMutation(
          input,
          "stop",
          ["forward", "stop", String(port), input.sandboxName, "--gateway", input.gatewayName],
          timing,
        );
      }
      invokeMutation(
        input,
        "start",
        [
          "forward",
          "start",
          "--background",
          String(port),
          input.sandboxName,
          "--gateway",
          input.gatewayName,
        ],
        timing,
      );
      final = settleStartedPort(input, port, requiredHealthy, timing);
      requiredHealthy.add(port);
    }

    requireNoOccupied(final);
    if (input.ports.some((port) => final.get(port) !== "healthy")) {
      failure("recovery-failed");
    }
    requireCurrent(input, false);
    timing.finish("proved");
    return retainForwardRecovery(input, touchedPorts, {
      kind: "restored",
      restoredPorts: [...missing],
    });
  } catch (error) {
    let normalized = normalizeFailure(error);
    try {
      if (touchedPorts.length > 0) {
        rollbackTouchedPorts(input, touchedPorts);
      }
    } catch {
      normalized = new HermesPortableForwardRecoveryError("restoration-unproved");
    } finally {
      timing.finish("failed");
    }
    throw normalized;
  }
}

/** Restore and commit the exact launch-readiness forward set for one Hermes probe. */
export function recoverHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): HermesPortableForwardRecoveryResult {
  return prepareHermesPortableLaunchForwards(input).release();
}

/** Verify the exact launch-readiness forward set without starting or stopping a forward. */
export function verifyHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): HermesPortableForwardVerificationResult {
  validatePorts(input);
  try {
    const states = observeForwards(input, false);
    requireNoOccupied(states);
    requireCurrent(input, false);
    return Object.freeze({
      kind: input.ports.every((port) => states.get(port) === "healthy") ? "healthy" : "unhealthy",
    });
  } catch (error) {
    throw normalizeFailure(error);
  }
}

function sleepMilliseconds(milliseconds: number): void {
  if (milliseconds <= 0 || !Number.isFinite(milliseconds)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
