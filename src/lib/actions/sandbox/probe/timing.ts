// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeSync } from "node:fs";

export const PROBE_TIMING_STAGES = [
  "readiness",
  "authority",
  "lifecycle",
  "gateway",
  "processes",
  "forward",
  "inference",
  "pairing",
  "publication",
] as const;

export const PROBE_READINESS_OBSERVATION_STAGES = [
  "sandbox-identity",
  "policy-get",
  "inference-get",
  "gateway-health",
  "forward-health",
  "inference-route",
] as const;

export type ProbeTimingStage = (typeof PROBE_TIMING_STAGES)[number];
export type ProbeReadinessObservationStage = (typeof PROBE_READINESS_OBSERVATION_STAGES)[number];
export type ProbeTimingResult = "ready" | "failed";
export type ProbeLifecycleAction = "skipped" | "reused" | "recovered" | "failed";
export type ProbeForwardAction = "skipped" | "verified" | "restored" | "failed";
export type ProbeReadinessDecisionCategory =
  | "accepted"
  | "missing"
  | "unsafe"
  | "malformed"
  | "expired"
  | "identity"
  | "config"
  | "health"
  | "session";

export type ProbeTimingRecorder = {
  measure<T>(stage: ProbeTimingStage, operation: () => T): T;
  measureAsync<T>(stage: ProbeTimingStage, operation: () => Promise<T>): Promise<T>;
  setLifecycleAction(action: ProbeLifecycleAction): void;
  setForwardAction(action: ProbeForwardAction): void;
  markFailureStage(stage: ProbeTimingStage): void;
  recordReadinessObservation(stage: ProbeReadinessObservationStage, elapsedMs: number): void;
  recordReadinessObservationFailure(stage: ProbeReadinessObservationStage): void;
  recordReadinessDecision(category: ProbeReadinessDecisionCategory): void;
  finish(result: ProbeTimingResult, failedStage?: ProbeTimingStage): void;
  finishOnExit(result: ProbeTimingResult, failedStage?: ProbeTimingStage): void;
  activeStage(): ProbeTimingStage | null;
};

type ProbeTimingDeps = {
  now?: () => number;
  write?: (line: string) => void;
};

function safeElapsed(startedAt: number | null, finishedAt: number | null): number {
  if (startedAt === null || finishedAt === null) return 0;
  return Math.max(0, Math.round(finishedAt - startedAt));
}

/**
 * Record one bounded, credential-free timing line for `connect --probe-only`.
 * Every diagnostic operation is fail-open so observability can never alter the
 * probe result or hide its original failure.
 */
export function createProbeTimingRecorder(deps: ProbeTimingDeps = {}): ProbeTimingRecorder {
  const now = deps.now ?? (() => performance.now());
  const write = deps.write ?? ((line: string) => console.log(line));
  const writeOnExit = deps.write ?? ((line: string) => writeSync(1, `${line}\n`));
  const durations = new Map<ProbeTimingStage, number>();
  const readinessObservationDurations = new Map<ProbeReadinessObservationStage, number>();
  const readinessObservationAttempts = new Map<ProbeReadinessObservationStage, number>();
  const active: ProbeTimingStage[] = [];
  let lifecycleAction: ProbeLifecycleAction = "skipped";
  let forwardAction: ProbeForwardAction = "skipped";
  let recordedFailureStage: ProbeTimingStage | null = null;
  let firstReadinessObservationFailure: ProbeReadinessObservationStage | null = null;
  let firstReadinessDecision: ProbeReadinessDecisionCategory | null = null;
  let firstReadinessFallbackDecision: Exclude<ProbeReadinessDecisionCategory, "accepted"> | null =
    null;
  let finished = false;

  const safeNow = (): number | null => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const totalStartedAt = safeNow();

  const record = <T>(stage: ProbeTimingStage, operation: () => T): T => {
    const startedAt = safeNow();
    active.push(stage);
    try {
      return operation();
    } catch (error) {
      recordedFailureStage ??= stage;
      throw error;
    } finally {
      active.pop();
      const elapsed = safeElapsed(startedAt, safeNow());
      durations.set(stage, (durations.get(stage) ?? 0) + elapsed);
    }
  };

  const recordAsync = async <T>(
    stage: ProbeTimingStage,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = safeNow();
    active.push(stage);
    try {
      return await operation();
    } catch (error) {
      recordedFailureStage ??= stage;
      throw error;
    } finally {
      active.pop();
      const elapsed = safeElapsed(startedAt, safeNow());
      durations.set(stage, (durations.get(stage) ?? 0) + elapsed);
    }
  };

  const emit = (
    result: ProbeTimingResult,
    failedStage: ProbeTimingStage | undefined,
    writeLine: (line: string) => void,
  ): void => {
    if (finished) return;
    finished = true;
    try {
      const totalMs = safeElapsed(totalStartedAt, safeNow());
      const stageFields = PROBE_TIMING_STAGES.map(
        (stage) => `${stage}=${String(durations.get(stage) ?? 0)}ms`,
      );
      const readinessObservationFields = PROBE_READINESS_OBSERVATION_STAGES.map(
        (stage) =>
          `readiness.${stage}=${String(Math.max(0, Math.round(readinessObservationDurations.get(stage) ?? 0)))}ms readiness.${stage}.attempts=${String(readinessObservationAttempts.get(stage) ?? 0)}`,
      );
      const failure =
        result === "failed"
          ? ` failedStage=${failedStage ?? recordedFailureStage ?? active[active.length - 1] ?? "unknown"}`
          : "";
      writeLine(
        `  Probe timing: ${stageFields.join(" ")} ${readinessObservationFields.join(" ")} readiness.firstFailedObservation=${firstReadinessObservationFailure ?? "none"} readiness.firstDecision=${firstReadinessDecision ?? "none"} readiness.firstFallbackDecision=${firstReadinessFallbackDecision ?? "none"} total=${String(totalMs)}ms lifecycleAction=${lifecycleAction} forwardAction=${forwardAction} result=${result}${failure}`,
      );
    } catch {
      // Timing output must never change the probe's status or error message.
    }
  };
  const finish = (result: ProbeTimingResult, failedStage?: ProbeTimingStage): void =>
    emit(result, failedStage, write);

  return {
    measure: record,
    measureAsync: recordAsync,
    setLifecycleAction(action: ProbeLifecycleAction): void {
      lifecycleAction = action;
    },
    setForwardAction(action: ProbeForwardAction): void {
      forwardAction = action;
    },
    markFailureStage(stage: ProbeTimingStage): void {
      recordedFailureStage ??= stage;
    },
    recordReadinessObservation(stage: ProbeReadinessObservationStage, elapsedMs: number): void {
      if (!Number.isFinite(elapsedMs)) return;
      readinessObservationAttempts.set(stage, (readinessObservationAttempts.get(stage) ?? 0) + 1);
      readinessObservationDurations.set(
        stage,
        (readinessObservationDurations.get(stage) ?? 0) + Math.max(0, elapsedMs),
      );
    },
    recordReadinessObservationFailure(stage: ProbeReadinessObservationStage): void {
      firstReadinessObservationFailure ??= stage;
    },
    recordReadinessDecision(category: ProbeReadinessDecisionCategory): void {
      firstReadinessDecision ??= category;
      if (category !== "accepted") {
        firstReadinessFallbackDecision ??= category;
      }
    },
    finish,
    finishOnExit(result: ProbeTimingResult, failedStage?: ProbeTimingStage): void {
      emit(result, failedStage, writeOnExit);
    },
    activeStage: () => active[active.length - 1] ?? null,
  };
}
