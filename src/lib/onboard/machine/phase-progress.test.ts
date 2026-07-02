// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createPhaseProgressReporter,
  ONBOARD_PHASE_LABELS,
  type PhaseProgressOptions,
  type PhaseProgressRecord,
  resolvePhaseProgressEnabled,
} from "./phase-progress";
import type { OnboardSequencePhase } from "./sequence-runner";

interface Harness {
  lines: string[];
  records: PhaseProgressRecord[];
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  clockMs: number;
  timerCallback: (() => void) | null;
  timerIntervalMs: number | null;
  cleared: boolean;
  options: PhaseProgressOptions;
}

function makeHarness(overrides: Partial<PhaseProgressOptions> = {}): Harness {
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

function fakePhase(
  state: OnboardSequencePhase<string>["state"],
  run: (context: string) => Promise<{ context: string; result: unknown }>,
): OnboardSequencePhase<string> {
  return { state, run: run as OnboardSequencePhase<string>["run"] };
}

describe("resolvePhaseProgressEnabled", () => {
  it("honours an explicit truthy override", () => {
    expect(resolvePhaseProgressEnabled({ VITEST: "true", NEMOCLAW_ONBOARD_PROGRESS: "1" })).toBe(
      true,
    );
  });

  it("honours an explicit falsy override", () => {
    expect(resolvePhaseProgressEnabled({ NEMOCLAW_ONBOARD_PROGRESS: "0" })).toBe(false);
  });

  it("defaults off inside the Vitest runner", () => {
    expect(resolvePhaseProgressEnabled({ VITEST: "true" })).toBe(false);
    expect(resolvePhaseProgressEnabled({ NODE_ENV: "test" })).toBe(false);
  });

  it("defaults on for real runs", () => {
    expect(resolvePhaseProgressEnabled({})).toBe(true);
  });
});

describe("createPhaseProgressReporter", () => {
  it("returns the phase unchanged when disabled (no side effects)", async () => {
    const harness = makeHarness({ enabled: false });
    const reporter = createPhaseProgressReporter(harness.options);
    const phase = fakePhase("gateway", async () => ({ context: "ctx", result: "done" }));
    const wrapped = reporter.wrap(phase);
    expect(wrapped).toBe(phase);
    await wrapped.run("ctx");
    expect(harness.records).toHaveLength(0);
    expect(harness.lines).toHaveLength(0);
  });

  it("records timing and a trace event on completion", async () => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    const wrapped = reporter.wrap(
      fakePhase("gateway", async () => {
        harness.clockMs = 42_000;
        return { context: "ctx", result: "ok" };
      }),
    );

    const result = await wrapped.run("ctx");

    expect(result).toEqual({ context: "ctx", result: "ok" });
    expect(harness.records).toEqual([
      { phase: "gateway", label: "Gateway startup", durationMs: 42_000, status: "completed" },
    ]);
    expect(harness.events[0]).toMatchObject({
      name: "onboard.phase.timing",
      attributes: { phase: "gateway", duration_ms: 42_000, status: "completed" },
    });
    expect(harness.cleared).toBe(true);
  });

  it("prints a completion line only when the phase crosses the threshold", async () => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);

    const fast = reporter.wrap(
      fakePhase("gateway", async () => {
        harness.clockMs = 1_000; // below 5s threshold
        return { context: "ctx", result: "ok" };
      }),
    );
    await fast.run("ctx");
    expect(harness.lines.filter((line) => line.includes("completed in"))).toHaveLength(0);

    harness.clockMs = 0;
    const slow = reporter.wrap(
      fakePhase("gateway", async () => {
        harness.clockMs = 10_000; // above threshold
        return { context: "ctx", result: "ok" };
      }),
    );
    await slow.run("ctx");
    expect(
      harness.lines.some((line) => line.includes("✓ Gateway startup completed in 10.0s")),
    ).toBe(true);
  });

  it("emits heartbeats for wait-heavy phases", async () => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    const wrapped = reporter.wrap(
      fakePhase("gateway", async () => {
        // Simulate a heartbeat interval firing mid-phase.
        harness.clockMs = 30_000;
        harness.timerCallback?.();
        harness.clockMs = 31_000;
        return { context: "ctx", result: "ok" };
      }),
    );

    await wrapped.run("ctx");

    expect(harness.timerIntervalMs).toBe(30_000);
    expect(
      harness.lines.some((line) =>
        line.includes("⏳ Still working on Gateway startup… (30s elapsed)"),
      ),
    ).toBe(true);
    // The heartbeat count is threaded into the trace event.
    expect(harness.events[0].attributes).toMatchObject({ heartbeats: 1 });
  });

  it("does not schedule heartbeats for interactive phases", async () => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    const wrapped = reporter.wrap(
      fakePhase("provider_selection", async () => ({ context: "ctx", result: "ok" })),
    );

    await wrapped.run("ctx");

    expect(harness.timerCallback).toBeNull();
    expect(harness.lines.some((line) => line.includes("Still working on"))).toBe(false);
  });

  it("records a failure, clears the timer, and rethrows", async () => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    const boom = new Error("gateway exploded");
    const wrapped = reporter.wrap(
      fakePhase("gateway", async () => {
        harness.clockMs = 9_000;
        throw boom;
      }),
    );

    await expect(wrapped.run("ctx")).rejects.toThrow("gateway exploded");
    expect(harness.records).toEqual([
      { phase: "gateway", label: "Gateway startup", durationMs: 9_000, status: "failed" },
    ]);
    expect(harness.cleared).toBe(true);
    expect(harness.lines.some((line) => line.includes("✗ Gateway startup failed after 9.0s"))).toBe(
      true,
    );
  });

  it("falls back to the raw state name for unknown phases", async () => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    const wrapped = reporter.wrap(
      fakePhase("mystery" as OnboardSequencePhase<string>["state"], async () => {
        harness.clockMs = 6_000;
        return { context: "ctx", result: "ok" };
      }),
    );
    await wrapped.run("ctx");
    expect(harness.records[0].label).toBe("mystery");
  });

  it("exposes friendly labels for the known phases", () => {
    expect(ONBOARD_PHASE_LABELS.gateway).toBe("Gateway startup");
    expect(ONBOARD_PHASE_LABELS.sandbox).toBe("Sandbox creation");
  });
});
