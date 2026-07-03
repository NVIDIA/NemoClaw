// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared test doubles for the phase-progress reporter suites. Kept in a
// non-`.test.ts` module so both phase-progress.test.ts (reporter behaviour) and
// phase-progress-seam.test.ts (sequence-runner wiring) drive the reporter
// through the same fake clock/timer/logger harness.

import type { PhaseProgressOptions, PhaseProgressRecord } from "./phase-progress";
import type { OnboardSequencePhase } from "./sequence-runner";

export interface Harness {
  lines: string[];
  records: PhaseProgressRecord[];
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  clockMs: number;
  timerCallback: (() => void) | null;
  timerIntervalMs: number | null;
  cleared: boolean;
  options: PhaseProgressOptions;
}

export function makeHarness(overrides: Partial<PhaseProgressOptions> = {}): Harness {
  const state: Harness = {
    lines: [],
    records: [],
    events: [],
    clockMs: 0,
    timerCallback: null,
    timerIntervalMs: null,
    cleared: false,
    options: {},
  };
  state.options = {
    enabled: true,
    logLine: (line) => state.lines.push(line),
    now: () => state.clockMs,
    setTimer: (callback, intervalMs) => {
      state.timerCallback = callback;
      state.timerIntervalMs = intervalMs;
      return { unref: () => {} };
    },
    clearTimer: () => {
      state.cleared = true;
    },
    traceEvent: (name, attributes) => state.events.push({ name, attributes }),
    record: (record) => state.records.push(record),
    heartbeatIntervalMs: 30_000,
    completionThresholdMs: 5_000,
    ...overrides,
  };
  return state;
}

export function fakePhase(
  state: OnboardSequencePhase<string>["state"],
  run: (context: string) => Promise<{ context: string; result: unknown }>,
): OnboardSequencePhase<string> {
  return { state, run: run as OnboardSequencePhase<string>["run"] };
}
