// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  readonly isReachable?: (port: number) => boolean;
  readonly launch: (port: number) => void;
  readonly migrateLegacy: (ports: readonly number[]) => void;
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

function validate(input: HermesPortableForwardRecoveryInput): void {
  if (
    input.intent !== "connect-probe-only" ||
    input.ports.length === 0 ||
    new Set(input.ports).size !== input.ports.length ||
    input.ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65_535)
  ) {
    failure("forward-state-unavailable");
  }
}

function reachablePorts(input: HermesPortableForwardRecoveryInput): Set<number> {
  const isReachable = input.deps.isReachable ?? (() => false);
  return new Set(input.ports.filter((port) => isReachable(port)));
}

function timing(
  input: HermesPortableForwardRecoveryInput,
  startedAt: number,
  startCount: number,
  result: "proved" | "failed",
): void {
  input.timing?.onComplete({
    listMs: 0,
    listCount: input.ports.length,
    stopMs: 0,
    stopCount: 0,
    startMs: 0,
    startCount,
    settleMs: 0,
    settleCount: 0,
    totalMs: Math.max(0, Math.round((input.timing?.now ?? (() => performance.now()))() - startedAt)),
    result,
  });
}

export function prepareHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): PreparedHermesPortableForwardRecovery {
  validate(input);
  const now = input.timing?.now ?? (() => performance.now());
  const startedAt = now();
  let startCount = 0;
  try {
    input.deps.assertCurrent();
    const missing = input.ports.filter((port) => !reachablePorts(input).has(port));
    if (missing.length > 0) {
      input.deps.migrateLegacy(missing);
      input.deps.assertCurrent();
      for (const port of missing) {
        input.deps.launch(port);
        startCount += 1;
        input.deps.assertCurrent();
      }
    }
    if (reachablePorts(input).size !== input.ports.length) failure("recovery-failed");
    const result: HermesPortableForwardRecoveryResult = {
      kind: missing.length === 0 ? "verified" : "restored",
      restoredPorts: missing,
    };
    timing(input, startedAt, startCount, "proved");
    let released = false;
    return {
      result,
      release: () => {
        if (released) failure("recovery-failed");
        released = true;
        return result;
      },
      rollback: () => {
        if (released) failure("restoration-unproved");
        input.deps.assertRollbackCurrent();
        released = true;
      },
    };
  } catch (error) {
    timing(input, startedAt, startCount, "failed");
    throw error instanceof HermesPortableForwardRecoveryError
      ? error
      : new HermesPortableForwardRecoveryError("recovery-failed");
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
  return { kind: reachablePorts(input).size === input.ports.length ? "healthy" : "unhealthy" };
}
