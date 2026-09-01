// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ForwardServiceController,
  ForwardServiceEndpoint,
  ForwardServiceSandboxAuthority,
} from "../../../adapters/openshell/forward-service-controller";

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
  readonly authority: ForwardServiceSandboxAuthority;
  readonly controller: ForwardServiceController;
  readonly migrateLegacy: () => void;
  readonly now?: () => number;
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

function failure(kind: HermesPortableForwardRecoveryFailure): never {
  throw new HermesPortableForwardRecoveryError(kind);
}

function normalizeFailure(error: unknown): HermesPortableForwardRecoveryError {
  return error instanceof HermesPortableForwardRecoveryError
    ? error
    : new HermesPortableForwardRecoveryError("recovery-failed");
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function timingRecorder(timing?: HermesPortableForwardRecoveryTiming) {
  const now = timing?.now ?? (() => performance.now());
  const startedAt = safeNow(now);
  const durations = new Map<ForwardTimingStage, number>();
  const counts = new Map<ForwardTimingStage, number>();
  let finished = false;
  const measure = <T>(stage: ForwardTimingStage, operation: () => T): T => {
    const start = safeNow(now);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    try {
      return operation();
    } finally {
      durations.set(stage, (durations.get(stage) ?? 0) + Math.max(0, safeNow(now) - start));
    }
  };
  const finish = (result: "proved" | "failed"): void => {
    if (finished) return;
    finished = true;
    if (!timing) return;
    const value = (stage: ForwardTimingStage) => Math.round(durations.get(stage) ?? 0);
    timing.onComplete({
      listMs: value("list"),
      listCount: counts.get("list") ?? 0,
      stopMs: value("stop"),
      stopCount: counts.get("stop") ?? 0,
      startMs: value("start"),
      startCount: counts.get("start") ?? 0,
      settleMs: value("settle"),
      settleCount: counts.get("settle") ?? 0,
      totalMs: Math.round(Math.max(0, safeNow(now) - startedAt)),
      result,
    });
  };
  return { finish, measure };
}

function validate(input: HermesPortableForwardRecoveryInput): void {
  if (
    input.intent !== "connect-probe-only" ||
    input.sandboxName !== input.deps.authority.sandboxName ||
    input.gatewayName !== input.deps.authority.gatewayName ||
    input.ports.length === 0 ||
    new Set(input.ports).size !== input.ports.length ||
    input.ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65_535)
  ) {
    failure("forward-state-unavailable");
  }
}

function endpoint(port: number): ForwardServiceEndpoint {
  return { localHost: "127.0.0.1", localPort: port, targetPort: port };
}

function assertCurrent(input: HermesPortableForwardRecoveryInput, rollback = false): void {
  try {
    (rollback ? input.deps.assertRollbackCurrent : input.deps.assertCurrent)();
  } catch {
    failure(rollback ? "restoration-unproved" : "authority-drift");
  }
}

function healthyPorts(
  input: HermesPortableForwardRecoveryInput,
  recorder: ReturnType<typeof timingRecorder>,
): Set<number> {
  assertCurrent(input);
  const healthy = new Set<number>();
  for (const port of input.ports) {
    const inspection = recorder.measure("list", () =>
      input.deps.controller.inspect(input.deps.authority, endpoint(port)),
    );
    if (inspection.disposition === "owned") {
      if (inspection.ownsListener === true && inspection.reachable) healthy.add(port);
      continue;
    }
    if (inspection.disposition !== "absent" && inspection.reachable) failure("forward-occupied");
  }
  assertCurrent(input);
  return healthy;
}

function rollbackTouched(
  input: HermesPortableForwardRecoveryInput,
  touched: readonly number[],
  recorder: ReturnType<typeof timingRecorder>,
): void {
  for (const port of [...touched].reverse()) {
    assertCurrent(input, true);
    try {
      recorder.measure("stop", () =>
        input.deps.controller.stop(input.deps.authority, endpoint(port)),
      );
    } catch {
      failure("restoration-unproved");
    }
    assertCurrent(input, true);
  }
}

function preparedResult(
  input: HermesPortableForwardRecoveryInput,
  touched: readonly number[],
  result: HermesPortableForwardRecoveryResult,
  recorder: ReturnType<typeof timingRecorder>,
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
      rollbackTouched(input, touched, recorder);
    },
  });
}

/** Prepare direct ForwardTcp services while retaining exact receipt-owned rollback. */
export function prepareHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): PreparedHermesPortableForwardRecovery {
  const recorder = timingRecorder(input.timing);
  const touched: number[] = [];
  try {
    validate(input);
    const initial = healthyPorts(input, recorder);
    const missing = input.ports.filter((port) => !initial.has(port));
    if (missing.length === 0) {
      recorder.finish("proved");
      return preparedResult(input, touched, { kind: "verified", restoredPorts: [] }, recorder);
    }
    assertCurrent(input);
    input.deps.migrateLegacy();
    assertCurrent(input);
    for (const port of missing) {
      touched.push(port);
      recorder.measure("start", () =>
        input.deps.controller.ensure(input.deps.authority, endpoint(port)),
      );
      assertCurrent(input);
    }
    if (healthyPorts(input, recorder).size !== input.ports.length) failure("recovery-failed");
    const result = { kind: "restored" as const, restoredPorts: [...missing] };
    recorder.finish("proved");
    return preparedResult(input, touched, result, recorder);
  } catch (error) {
    let normalized = normalizeFailure(error);
    try {
      rollbackTouched(input, touched, recorder);
    } catch {
      normalized = new HermesPortableForwardRecoveryError("restoration-unproved");
    }
    recorder.finish("failed");
    throw normalized;
  }
}

export function recoverHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): HermesPortableForwardRecoveryResult {
  return prepareHermesPortableLaunchForwards(input).release();
}

export function verifyHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): HermesPortableForwardVerificationResult {
  validate(input);
  const recorder = timingRecorder();
  try {
    return Object.freeze({
      kind: healthyPorts(input, recorder).size === input.ports.length ? "healthy" : "unhealthy",
    });
  } catch (error) {
    throw normalizeFailure(error);
  }
}
