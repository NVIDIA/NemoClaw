// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeOutputEvent } from "./shell-probe.ts";

const ONBOARD_SCOPE = "nemoclaw.onboard";
const ONBOARD_ROOT_SPAN = "nemoclaw.onboard";
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export interface OnboardTraceWindow {
  durationMs: number;
  finishedAtMs: number;
  startedAtMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function unixNanoseconds(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`onboard root span has an invalid ${field}`);
  }
  return BigInt(value);
}

export function readOnboardTraceWindow(artifact: unknown): OnboardTraceWindow {
  const resourceSpans = asRecord(artifact)?.resource_spans;
  if (!Array.isArray(resourceSpans)) {
    throw new Error("trace artifact is missing resource_spans");
  }

  const roots: Record<string, unknown>[] = [];
  for (const resourceSpan of resourceSpans) {
    const scopeSpans = asRecord(resourceSpan)?.scope_spans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const scopeSpan of scopeSpans) {
      const scopeSpanRecord = asRecord(scopeSpan);
      if (asRecord(scopeSpanRecord?.scope)?.name !== ONBOARD_SCOPE) continue;
      const spans = scopeSpanRecord?.spans;
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        const record = asRecord(span);
        if (record?.name === ONBOARD_ROOT_SPAN) roots.push(record);
      }
    }
  }

  if (roots.length !== 1) {
    throw new Error("trace artifact must contain exactly one onboard root span");
  }
  const root = roots[0];
  if (asRecord(root.status)?.code !== "OK") {
    throw new Error("onboard root span status is missing or not OK");
  }

  const startedAtNs = unixNanoseconds(root.start_time_unix_nano, "start time");
  const finishedAtNs = unixNanoseconds(root.end_time_unix_nano, "end time");
  if (finishedAtNs < startedAtNs) {
    throw new Error("onboard root span ends before it starts");
  }

  return {
    durationMs: Number((finishedAtNs - startedAtNs) / NANOSECONDS_PER_MILLISECOND),
    finishedAtMs: Number(finishedAtNs / NANOSECONDS_PER_MILLISECOND),
    startedAtMs: Number(startedAtNs / NANOSECONDS_PER_MILLISECOND),
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
