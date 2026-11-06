// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const OPERATIONS = [
  "nemoclaw.inference.endpoint_preflight",
  "nemoclaw.inference.validation_timeout_calibration",
  "nemoclaw.inference.validation_probe",
  "nemoclaw.inference.context_window_discovery",
] as const;

type Operation = (typeof OPERATIONS)[number];
type SpanStatus = "OK" | "ERROR" | "UNSET";

export interface ProviderTiming {
  observations: Array<{
    operation: Operation;
    offsetMs: number;
    durationMs: number;
    status: SpanStatus;
  }>;
  rejectedObservations: number;
  coveredMs: number;
  unattributedMs: number;
}

interface TimingSpan {
  id: string;
  parentId: unknown;
  start: bigint;
  end: bigint;
  status: SpanStatus;
}

function timingSpan(record: Record<string, unknown>): TimingSpan | null {
  const status = (record.status as { code?: unknown } | null)?.code;
  if (
    typeof record.span_id !== "string" ||
    !/^[0-9a-f]{16}$/u.test(record.span_id) ||
    typeof record.start_time_unix_nano !== "string" ||
    !/^\d{1,24}$/u.test(record.start_time_unix_nano) ||
    typeof record.end_time_unix_nano !== "string" ||
    !/^\d{1,24}$/u.test(record.end_time_unix_nano) ||
    (status !== "OK" && status !== "ERROR" && status !== "UNSET")
  )
    return null;
  const start = BigInt(record.start_time_unix_nano);
  const end = BigInt(record.end_time_unix_nano);
  const duration = Number(end - start) / 1e6;
  if (
    end < start ||
    typeof record.duration_ms !== "number" ||
    !Number.isFinite(record.duration_ms) ||
    Math.abs(duration - record.duration_ms) > 0.001
  )
    return null;
  return { id: record.span_id, parentId: record.parent_span_id, start, end, status };
}

/** Receives the already validated provider phase. Never retains attributes, events, IDs or errors. */
export function summarizeProviderTiming(
  phase: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
): ProviderTiming {
  const window = timingSpan(phase);
  const result: ProviderTiming = {
    observations: [],
    rejectedObservations: 0,
    coveredMs: 0,
    unattributedMs: typeof phase.duration_ms === "number" ? phase.duration_ms : 0,
  };
  if (!window) return result;
  const spans = new Map<string, TimingSpan | null>();
  for (const record of records) {
    if (record.trace_id !== phase.trace_id) continue;
    const span = timingSpan(record);
    if (span) spans.set(span.id, spans.has(span.id) ? null : span);
  }
  const intervals: TimingSpan[] = [];
  for (const record of records) {
    if (record.trace_id !== phase.trace_id || !OPERATIONS.includes(record.name as Operation))
      continue;
    const span = timingSpan(record);
    let cursor = span;
    const visited = new Set<string>();
    while (cursor && cursor.id !== window.id && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      const parent = spans.get(String(cursor.parentId));
      cursor = parent && cursor.start >= parent.start && cursor.end <= parent.end ? parent : null;
    }
    if (!span || spans.get(span.id) === null || cursor?.id !== window.id) {
      result.rejectedObservations++;
      continue;
    }
    intervals.push(span);
    result.observations.push({
      operation: record.name as Operation,
      offsetMs: Number(span.start - window.start) / 1e6,
      durationMs: Number(span.end - span.start) / 1e6,
      status: span.status,
    });
  }
  // Union nested/overlapping intervals so they cannot hide unattributed provider time.
  intervals.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let end = window.start;
  let covered = 0n;
  for (const span of intervals) {
    const start = span.start > end ? span.start : end;
    if (span.end > start) covered += span.end - start;
    if (span.end > end) end = span.end;
  }
  result.coveredMs = Number(covered) / 1e6;
  result.unattributedMs = Number(window.end - window.start - covered) / 1e6;
  return result;
}
