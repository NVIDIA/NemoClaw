// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeOutputEvent } from "./shell-probe.ts";

const ONBOARD_SCOPE = "nemoclaw.onboard";
const ONBOARD_ROOT_SPAN = "nemoclaw.onboard";
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const DURATION_TOLERANCE_MS = 0.001;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
export const ONBOARD_PHASE_NAMES = [
  "nemoclaw.onboard.phase.preflight",
  "nemoclaw.onboard.phase.gateway",
  "nemoclaw.onboard.phase.provider_selection",
  "nemoclaw.onboard.phase.inference",
  "nemoclaw.onboard.phase.sandbox",
] as const;

export type OnboardPhaseName = (typeof ONBOARD_PHASE_NAMES)[number];

const ONBOARD_PHASE_NAME_SET = new Set<string>(ONBOARD_PHASE_NAMES);
const COLD_ONBOARD_BUDGET_KEYS = new Set([
  "authoritativeLocalBaseBuildAllowanceMs",
  "rootStartToFirstTurnCompletionBudgetMs",
  "rootEndToFirstTurnCompletionBudgetMs",
  "phaseBudgetsMs",
]);

export interface OnboardTraceWindow {
  durationMs: number;
  finishedAtMs: number;
  phaseDurationsMs: Record<OnboardPhaseName, number>;
  startedAtMs: number;
}

export interface ColdOnboardPerformanceBudget {
  authoritativeLocalBaseBuildAllowanceMs: number;
  phaseBudgetsMs: Record<OnboardPhaseName, number>;
  rootEndToFirstTurnCompletionBudgetMs: number;
  rootStartToFirstTurnCompletionBudgetMs: number;
}

export interface ColdOnboardPerformanceEvaluation {
  appliedAuthoritativeLocalBaseBuildAllowanceMs: number;
  passed: boolean;
  rootEndToFirstTurnCompletionMs: number;
  rootStartToFirstTurnCompletionMs: number;
  violations: string[];
}

interface ParsedSpan {
  durationMs: number;
  endNs: bigint;
  record: Record<string, unknown>;
  spanId: string;
  startNs: bigint;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function unixNanoseconds(value: unknown, spanLabel: string, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`${spanLabel} span has an invalid ${field}`);
  }
  return BigInt(value);
}

function durationMilliseconds(value: unknown, spanLabel: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${spanLabel} span has an invalid duration`);
  }
  return value;
}

function identifier(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`trace artifact has an invalid ${field}`);
  }
  return value;
}

function parseSpan(
  record: Record<string, unknown>,
  spanLabel: string,
  expectedTraceId: string,
): ParsedSpan {
  const traceId = identifier(record.trace_id, TRACE_ID_PATTERN, `${spanLabel} trace_id`);
  if (traceId !== expectedTraceId) {
    throw new Error(`${spanLabel} span does not belong to the onboard trace`);
  }
  const spanId = identifier(record.span_id, SPAN_ID_PATTERN, `${spanLabel} span_id`);
  if (asRecord(record.status)?.code !== "OK") {
    throw new Error(`${spanLabel} span status is missing or not OK`);
  }
  const startNs = unixNanoseconds(record.start_time_unix_nano, spanLabel, "start time");
  const endNs = unixNanoseconds(record.end_time_unix_nano, spanLabel, "end time");
  if (endNs < startNs) {
    throw new Error(`${spanLabel} span ends before it starts`);
  }
  const durationMs = durationMilliseconds(record.duration_ms, spanLabel);
  const timestampDurationMs = Number(endNs - startNs) / Number(NANOSECONDS_PER_MILLISECOND);
  if (Math.abs(timestampDurationMs - durationMs) > DURATION_TOLERANCE_MS) {
    throw new Error(`${spanLabel} span duration does not match its timestamps`);
  }
  return { durationMs, endNs, record, spanId, startNs };
}

function nonNegativeMilliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asColdOnboardBudget(value: unknown): ColdOnboardPerformanceBudget | null {
  const record = asRecord(value);
  if (!record || Object.keys(record).some((key) => !COLD_ONBOARD_BUDGET_KEYS.has(key))) return null;
  const rootStartToFirstTurnCompletionBudgetMs = nonNegativeMilliseconds(
    record.rootStartToFirstTurnCompletionBudgetMs,
  );
  const rootEndToFirstTurnCompletionBudgetMs = nonNegativeMilliseconds(
    record.rootEndToFirstTurnCompletionBudgetMs,
  );
  const authoritativeLocalBaseBuildAllowanceMs = nonNegativeMilliseconds(
    record.authoritativeLocalBaseBuildAllowanceMs,
  );
  const phaseBudgets = asRecord(record.phaseBudgetsMs);
  if (
    authoritativeLocalBaseBuildAllowanceMs === null ||
    rootStartToFirstTurnCompletionBudgetMs === null ||
    rootEndToFirstTurnCompletionBudgetMs === null ||
    rootEndToFirstTurnCompletionBudgetMs > rootStartToFirstTurnCompletionBudgetMs ||
    !phaseBudgets
  ) {
    return null;
  }

  if (Object.keys(phaseBudgets).some((name) => !ONBOARD_PHASE_NAME_SET.has(name))) return null;
  const phaseBudgetsMs = {} as Record<OnboardPhaseName, number>;
  for (const name of ONBOARD_PHASE_NAMES) {
    const validatedBudgetMs = nonNegativeMilliseconds(phaseBudgets[name]);
    if (validatedBudgetMs === null) return null;
    phaseBudgetsMs[name] = validatedBudgetMs;
  }

  return {
    authoritativeLocalBaseBuildAllowanceMs,
    rootStartToFirstTurnCompletionBudgetMs,
    rootEndToFirstTurnCompletionBudgetMs,
    phaseBudgetsMs,
  };
}

export function readColdOnboardPerformanceBudget(value: unknown): ColdOnboardPerformanceBudget {
  const budget = asColdOnboardBudget(asRecord(value)?.fullE2eColdPath);
  if (!budget) {
    throw new Error("fullE2eColdPath performance budget is invalid or missing");
  }
  return budget;
}

export function readOnboardTraceWindow(artifact: unknown): OnboardTraceWindow {
  const artifactRecord = asRecord(artifact);
  const summaryTraceId = identifier(
    asRecord(artifactRecord?.summary)?.trace_id,
    TRACE_ID_PATTERN,
    "summary trace_id",
  );
  const resourceSpans = artifactRecord?.resource_spans;
  if (!Array.isArray(resourceSpans)) {
    throw new Error("trace artifact is missing resource_spans");
  }

  const roots: Record<string, unknown>[] = [];
  const phases = new Map<OnboardPhaseName, Record<string, unknown>>();
  for (const resourceSpan of resourceSpans) {
    const scopeSpans = asRecord(resourceSpan)?.scope_spans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const scopeSpan of scopeSpans) {
      const scopeSpanRecord = asRecord(scopeSpan);
      if (asRecord(scopeSpanRecord?.scope)?.name !== ONBOARD_SCOPE) continue;
      const spans = scopeSpanRecord?.spans;
      if (!Array.isArray(spans) || spans.some((span) => asRecord(span) === null)) {
        throw new Error("onboard trace scope contains malformed spans");
      }
      for (const span of spans) {
        const record = span as Record<string, unknown>;
        if (record.trace_id !== summaryTraceId) continue;
        if (record?.name === ONBOARD_ROOT_SPAN) roots.push(record);
        if (typeof record?.name === "string" && ONBOARD_PHASE_NAME_SET.has(record.name)) {
          const phaseName = record.name as OnboardPhaseName;
          if (phases.has(phaseName)) {
            throw new Error(`trace artifact must contain exactly one ${phaseName} span`);
          }
          phases.set(phaseName, record);
        }
      }
    }
  }

  if (roots.length !== 1) {
    throw new Error("trace artifact must contain exactly one onboard root span");
  }
  const root = parseSpan(roots[0], "onboard root", summaryTraceId);
  if (root.record.parent_span_id !== undefined) {
    throw new Error("onboard root span must not have a parent");
  }

  const phaseDurationsMs = {} as Record<OnboardPhaseName, number>;
  const spanIds = new Set([root.spanId]);
  let previousPhaseEndNs = root.startNs;
  for (const phaseName of ONBOARD_PHASE_NAMES) {
    const record = phases.get(phaseName);
    if (!record) {
      throw new Error(`trace artifact is missing ${phaseName} span`);
    }
    const phase = parseSpan(record, `onboard phase ${phaseName}`, summaryTraceId);
    if (spanIds.has(phase.spanId)) {
      throw new Error(`trace artifact contains duplicate span_id ${phase.spanId}`);
    }
    spanIds.add(phase.spanId);
    if (phase.record.parent_span_id !== root.spanId) {
      throw new Error(`${phaseName} span is not a child of the onboard root`);
    }
    if (phase.startNs < root.startNs || phase.endNs > root.endNs) {
      throw new Error(`${phaseName} span is outside the onboard root window`);
    }
    if (phase.startNs < previousPhaseEndNs) {
      throw new Error(`${phaseName} span overlaps or precedes the prior onboard phase`);
    }
    previousPhaseEndNs = phase.endNs;
    phaseDurationsMs[phaseName] = phase.durationMs;
  }

  return {
    durationMs: root.durationMs,
    finishedAtMs: Number(root.endNs / NANOSECONDS_PER_MILLISECOND),
    phaseDurationsMs,
    startedAtMs: Number(root.startNs / NANOSECONDS_PER_MILLISECOND),
  };
}

export function evaluateColdOnboardPerformance(
  trace: Pick<OnboardTraceWindow, "finishedAtMs" | "phaseDurationsMs" | "startedAtMs">,
  firstTurnCompletedAtMs: number,
  budget: ColdOnboardPerformanceBudget,
  authoritativeLocalBaseBuild = false,
): ColdOnboardPerformanceEvaluation {
  if (
    !Number.isFinite(firstTurnCompletedAtMs) ||
    !Number.isFinite(trace.startedAtMs) ||
    !Number.isFinite(trace.finishedAtMs) ||
    trace.finishedAtMs < trace.startedAtMs ||
    firstTurnCompletedAtMs < trace.finishedAtMs
  ) {
    throw new Error("cold onboard timing boundaries are invalid");
  }

  const rootStartToFirstTurnCompletionMs = firstTurnCompletedAtMs - trace.startedAtMs;
  const rootEndToFirstTurnCompletionMs = firstTurnCompletedAtMs - trace.finishedAtMs;
  const appliedAuthoritativeLocalBaseBuildAllowanceMs = authoritativeLocalBaseBuild
    ? budget.authoritativeLocalBaseBuildAllowanceMs
    : 0;
  const rootStartBudgetMs =
    budget.rootStartToFirstTurnCompletionBudgetMs + appliedAuthoritativeLocalBaseBuildAllowanceMs;
  const sandboxBudgetMs =
    budget.phaseBudgetsMs["nemoclaw.onboard.phase.sandbox"] +
    appliedAuthoritativeLocalBaseBuildAllowanceMs;
  const violations: string[] = [];
  if (rootStartToFirstTurnCompletionMs > rootStartBudgetMs) {
    violations.push(
      `root-start-to-first-turn-completion ${rootStartToFirstTurnCompletionMs}ms exceeds ${rootStartBudgetMs}ms`,
    );
  }
  if (rootEndToFirstTurnCompletionMs > budget.rootEndToFirstTurnCompletionBudgetMs) {
    violations.push(
      `root-end-to-first-turn-completion ${rootEndToFirstTurnCompletionMs}ms exceeds ${budget.rootEndToFirstTurnCompletionBudgetMs}ms`,
    );
  }
  for (const phaseName of ONBOARD_PHASE_NAMES) {
    const phaseBudgetMs =
      phaseName === "nemoclaw.onboard.phase.sandbox"
        ? sandboxBudgetMs
        : budget.phaseBudgetsMs[phaseName];
    const phaseDurationMs = trace.phaseDurationsMs[phaseName];
    if (phaseBudgetMs !== undefined && phaseDurationMs > phaseBudgetMs) {
      violations.push(`${phaseName} ${phaseDurationMs}ms exceeds ${phaseBudgetMs}ms`);
    }
  }

  return {
    appliedAuthoritativeLocalBaseBuildAllowanceMs,
    passed: violations.length === 0,
    rootStartToFirstTurnCompletionMs,
    rootEndToFirstTurnCompletionMs,
    violations,
  };
}

export function maximumOutputSilenceMs(
  window: Pick<OnboardTraceWindow, "finishedAtMs" | "startedAtMs">,
  events: readonly Pick<ShellProbeOutputEvent, "atMs">[],
): number {
  const { finishedAtMs, startedAtMs } = window;
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(finishedAtMs) ||
    finishedAtMs < startedAtMs
  ) {
    throw new Error("onboard output window is invalid");
  }

  const outputTimes = events
    .map((event) => event.atMs)
    .filter((atMs) => atMs >= startedAtMs && atMs <= finishedAtMs)
    .sort((left, right) => left - right);
  const boundaries = [startedAtMs, ...outputTimes, finishedAtMs];
  return boundaries
    .slice(1)
    .reduce((maximum, atMs, index) => Math.max(maximum, atMs - boundaries[index]), 0);
}
