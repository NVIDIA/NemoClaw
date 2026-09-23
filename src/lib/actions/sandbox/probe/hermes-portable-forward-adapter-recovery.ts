// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellForwardAdapter,
  OpenShellForwardIdentity,
  OpenShellForwardObservation,
  OpenShellForwardStartFailure,
} from "../../../adapters/openshell/forward";
import { createOpenShellOperationDeadline } from "../../../adapters/openshell/operation-deadline";

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
  readonly onComplete: (evidence: HermesPortableForwardRecoveryTimingEvidence) => unknown;
}

export type HermesPortableForwardRecoveryFailure =
  | "authority-drift"
  | "forward-occupied"
  | "forward-state-unavailable"
  | "recovery-failed"
  | "restoration-unproved";

export type HermesPortableForwardRecoveryContext =
  | { readonly cause: "forward-list-failed" }
  | { readonly cause: "forward-list-invalid" }
  | { readonly cause: "forward-port-resolution-failed" }
  | { readonly cause: "forward-reachability-failed"; readonly port: number }
  | { readonly cause: "forward-settlement-timed-out" }
  | {
      readonly cause: "forward-mutation-failed";
      readonly operation: "start" | "stop";
      readonly port: number;
      readonly startupFailure?: OpenShellForwardStartFailure;
    }
  | { readonly cause: "port-occupied"; readonly port: number };

export class HermesPortableForwardRecoveryError extends Error {
  constructor(
    readonly failure: HermesPortableForwardRecoveryFailure,
    readonly context?: HermesPortableForwardRecoveryContext,
  ) {
    super(`Hermes Portable forward recovery failed: ${failure}`);
  }
}

export interface HermesPortableForwardRecoveryDeps {
  readonly adapter: OpenShellForwardAdapter;
  readonly assertCurrent: () => void | Promise<void>;
  readonly assertRollbackCurrent: () => void | Promise<void>;
  readonly now?: () => number;
}

export interface HermesPortableForwardRecoveryInput {
  readonly intent: "connect-probe-only";
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly operationTimeoutMs: number;
  readonly ports: readonly number[];
  readonly probeTimeoutMs: number;
  readonly forwards: readonly OpenShellForwardIdentity[];
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
  readonly rollback: () => Promise<void>;
}

type StartedForwardCleanup = Extract<
  Awaited<ReturnType<OpenShellForwardAdapter["startForward"]>>,
  { state: "started" }
>["cleanup"];

function failure(
  failureClass: HermesPortableForwardRecoveryFailure,
  context?: HermesPortableForwardRecoveryContext,
): never {
  throw new HermesPortableForwardRecoveryError(failureClass, context);
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
  readonly measureAsync: <T>(stage: ForwardTimingStage, operation: () => Promise<T>) => Promise<T>;
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
  return {
    async measureAsync<T>(stage: ForwardTimingStage, operation: () => Promise<T>): Promise<T> {
      const stageStartedAt = safeTimingNow(now);
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
      try {
        return await operation();
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
        const completion = timing.onComplete(
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
        if (completion instanceof Promise) void completion.catch(() => undefined);
      } catch {
        // Timing output must not change forward recovery.
      }
    },
  };
}

async function requireCurrent(
  input: HermesPortableForwardRecoveryInput,
  rollback: boolean,
): Promise<void> {
  try {
    await (rollback ? input.deps.assertRollbackCurrent() : input.deps.assertCurrent());
  } catch {
    failure(rollback ? "restoration-unproved" : "authority-drift");
  }
}

function validateInput(input: HermesPortableForwardRecoveryInput): void {
  if (
    input.intent !== "connect-probe-only" ||
    !Number.isFinite(input.operationTimeoutMs) ||
    input.operationTimeoutMs <= 0 ||
    !Number.isFinite(input.probeTimeoutMs) ||
    input.probeTimeoutMs <= 0 ||
    input.ports.length === 0 ||
    input.ports.length !== input.forwards.length ||
    new Set(input.ports).size !== input.ports.length
  ) {
    failure("forward-state-unavailable");
  }
  for (const [index, port] of input.ports.entries()) {
    const forward = input.forwards[index];
    if (
      !forward ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65_535 ||
      forward.port !== port ||
      forward.sandboxName !== input.sandboxName ||
      forward.gatewayName !== input.gatewayName
    ) {
      failure("forward-state-unavailable");
    }
  }
}

function requireUsableObservations(
  input: HermesPortableForwardRecoveryInput,
  observations: readonly OpenShellForwardObservation[],
): void {
  if (observations.length !== input.forwards.length) {
    failure("forward-state-unavailable", { cause: "forward-list-invalid" });
  }
  for (const [index, observation] of observations.entries()) {
    const forward = input.forwards[index];
    if (!forward || !("forward" in observation) || observation.forward.port !== forward.port) {
      failure("forward-state-unavailable", { cause: "forward-list-invalid" });
    }
    if (observation.state === "indeterminate") {
      failure("forward-state-unavailable", { cause: "forward-list-failed" });
    }
    if (observation.state === "foreign") {
      failure("forward-occupied", { cause: "port-occupied", port: forward.port });
    }
  }
}

async function observeForwards(
  input: HermesPortableForwardRecoveryInput,
  timing: ReturnType<typeof createForwardTimingRecorder>,
  timeoutMs: number,
  rollback = false,
): Promise<readonly OpenShellForwardObservation[]> {
  await requireCurrent(input, rollback);
  const observations = await timing.measureAsync("list", () =>
    input.deps.adapter.observeForwards({
      forwards: input.forwards,
      timeoutMs,
      assertCurrent: async () => requireCurrent(input, rollback),
    }),
  );
  await requireCurrent(input, rollback);
  requireUsableObservations(input, observations);
  return observations;
}

async function cleanupStartedForwards(
  input: HermesPortableForwardRecoveryInput,
  cleanups: readonly { port: number; cleanup: StartedForwardCleanup }[],
): Promise<void> {
  for (const started of [...cleanups].reverse()) {
    await requireCurrent(input, true);
    const released = await started.cleanup({
      timeoutMs: input.operationTimeoutMs,
      assertCurrent: async () => requireCurrent(input, true),
    });
    if (released.state !== "released") {
      failure("restoration-unproved", {
        cause: "forward-mutation-failed",
        operation: "stop",
        port: started.port,
      });
    }
  }
}

function retainForwardRecovery(
  input: HermesPortableForwardRecoveryInput,
  cleanups: readonly { port: number; cleanup: StartedForwardCleanup }[],
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
    rollback: async () => {
      if (state !== "prepared") failure("restoration-unproved");
      await cleanupStartedForwards(input, cleanups);
      state = "rolled-back";
    },
  });
}

export async function prepareHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): Promise<PreparedHermesPortableForwardRecovery> {
  const timing = createForwardTimingRecorder(input.timing);
  const cleanups: { port: number; cleanup: StartedForwardCleanup }[] = [];
  try {
    validateInput(input);
    const deadline = createOpenShellOperationDeadline(
      input.operationTimeoutMs,
      input.deps.now ?? (() => performance.now()),
    );
    const remaining = () => deadline.remaining(input.probeTimeoutMs, "forward recovery");
    const initial = await observeForwards(input, timing, remaining());
    const restoredPorts: number[] = [];

    for (const [index, observation] of initial.entries()) {
      const forward = input.forwards[index]!;
      if (observation.state === "owned") continue;
      if (observation.state === "stale") {
        const retirement = await timing.measureAsync("stop", () =>
          input.deps.adapter.retireLegacyForward({
            forward,
            timeoutMs: deadline.remaining(input.operationTimeoutMs, "forward recovery"),
            assertCurrent: async () => requireCurrent(input, false),
            authorize: async () => requireCurrent(input, false),
          }),
        );
        if (retirement.state !== "retired" && retirement.state !== "not_needed") {
          failure("recovery-failed", {
            cause: "forward-mutation-failed",
            operation: "stop",
            port: forward.port,
          });
        }
      }
      const started = await timing.measureAsync("start", () =>
        input.deps.adapter.startForward({
          forward,
          timeoutMs: deadline.remaining(input.operationTimeoutMs, "forward recovery"),
          assertCurrent: async () => requireCurrent(input, false),
        }),
      );
      if (started.state === "started") {
        restoredPorts.push(forward.port);
        cleanups.push({ port: forward.port, cleanup: started.cleanup });
      } else if (started.state !== "reused") {
        if (started.state === "refused" && started.observation.state === "foreign") {
          failure("forward-occupied", { cause: "port-occupied", port: forward.port });
        }
        const startupFailure = "failure" in started ? started.failure : undefined;
        if (started.state === "cleanup_uncertain") {
          failure("restoration-unproved", {
            cause: "forward-mutation-failed",
            operation: "start",
            port: forward.port,
            ...(startupFailure ? { startupFailure } : {}),
          });
        }
        failure("recovery-failed", {
          cause: "forward-mutation-failed",
          operation: "start",
          port: forward.port,
          ...(startupFailure ? { startupFailure } : {}),
        });
      }
    }

    const final = await timing.measureAsync("settle", () =>
      observeForwards(input, timing, remaining()),
    );
    if (final.some((observation) => observation.state !== "owned")) {
      failure("recovery-failed", { cause: "forward-settlement-timed-out" });
    }
    await requireCurrent(input, false);
    const result: HermesPortableForwardRecoveryResult = {
      kind: restoredPorts.length > 0 ? "restored" : "verified",
      restoredPorts,
    };
    timing.finish("proved");
    return retainForwardRecovery(input, cleanups, result);
  } catch (error) {
    let normalized = normalizeFailure(error);
    if (cleanups.length > 0) {
      try {
        await cleanupStartedForwards(input, cleanups);
      } catch {
        normalized = new HermesPortableForwardRecoveryError(
          "restoration-unproved",
          normalized.context,
        );
      }
    }
    timing.finish("failed");
    throw normalized;
  }
}

export async function recoverHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): Promise<HermesPortableForwardRecoveryResult> {
  return (await prepareHermesPortableLaunchForwards(input)).release();
}

export async function verifyHermesPortableLaunchForwards(
  input: HermesPortableForwardRecoveryInput,
): Promise<HermesPortableForwardVerificationResult> {
  validateInput(input);
  const timing = createForwardTimingRecorder(input.timing);
  try {
    const observed = await observeForwards(input, timing, input.probeTimeoutMs);
    await requireCurrent(input, false);
    timing.finish("proved");
    return Object.freeze({
      kind: observed.every((observation) => observation.state === "owned")
        ? "healthy"
        : "unhealthy",
    });
  } catch (error) {
    timing.finish("failed");
    throw normalizeFailure(error);
  }
}
