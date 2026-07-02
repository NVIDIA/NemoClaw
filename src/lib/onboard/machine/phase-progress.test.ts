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
import { buildOnboardSequenceHandlers, type OnboardSequencePhase } from "./sequence-runner";

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

  it.each([
    "gateway",
    "sandbox",
    "inference",
    "agent_setup",
    "openclaw",
    "finalizing",
  ])("keeps the wait-heavy phase %s on the heartbeat path", async (state) => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    await reporter
      .wrap(
        fakePhase(state as OnboardSequencePhase<string>["state"], async () => {
          harness.clockMs = 1;
          return { context: "ctx", result: "ok" };
        }),
      )
      .run("ctx");
    // A timer was scheduled for this state (heartbeat coverage guard).
    expect(harness.timerCallback, `heartbeat not scheduled for ${state}`).not.toBeNull();
  });

  it.each([
    "provider_selection",
    "policies",
  ])("does not schedule heartbeats for the interactive phase %s", async (state) => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    const wrapped = reporter.wrap(
      fakePhase(state as OnboardSequencePhase<string>["state"], async () => ({
        context: "ctx",
        result: "ok",
      })),
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

  it("exposes a non-empty friendly label for every known phase", () => {
    const entries = Object.entries(ONBOARD_PHASE_LABELS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [state, label] of entries) {
      expect(typeof label, `label for ${state}`).toBe("string");
      expect(label.trim().length, `label for ${state}`).toBeGreaterThan(0);
    }
    expect(ONBOARD_PHASE_LABELS.gateway).toBe("Gateway startup");
    expect(ONBOARD_PHASE_LABELS.sandbox).toBe("Sandbox creation");
  });

  it("does not reclassify a successful phase when telemetry throws", async () => {
    // A throwing recorder must not turn a successful phase into a failure, and
    // must not mask the phase's real return value (best-effort telemetry).
    const harness = makeHarness({
      record: () => {
        throw new Error("recorder blew up");
      },
    });
    const reporter = createPhaseProgressReporter(harness.options);
    const wrapped = reporter.wrap(
      fakePhase("gateway", async () => ({ context: "ctx", result: "ok" })),
    );

    await expect(wrapped.run("ctx")).resolves.toEqual({ context: "ctx", result: "ok" });
  });

  it("preserves a real phase failure even if telemetry also throws", async () => {
    const harness = makeHarness({
      record: () => {
        throw new Error("recorder blew up");
      },
    });
    const reporter = createPhaseProgressReporter(harness.options);
    const wrapped = reporter.wrap(
      fakePhase("gateway", async () => {
        throw new Error("real phase failure");
      }),
    );

    // The phase's own error wins over the telemetry error.
    await expect(wrapped.run("ctx")).rejects.toThrow("real phase failure");
  });

  it.each([
    ["", 30_000],
    ["0", 30_000],
    ["500", 30_000], // below the 1s minimum
    ["not-a-number", 30_000],
    ["12000", 12_000],
  ])("resolves heartbeat interval %s from env to %d ms", async (raw, expected) => {
    const harness = makeHarness({
      env: { NEMOCLAW_ONBOARD_HEARTBEAT_MS: raw },
      heartbeatIntervalMs: undefined,
    });
    const reporter = createPhaseProgressReporter(harness.options);
    await reporter
      .wrap(
        fakePhase("gateway", async () => {
          harness.clockMs = 1;
          return { context: "ctx", result: "ok" };
        }),
      )
      .run("ctx");
    expect(harness.timerIntervalMs).toBe(expected);
  });
});

describe("buildOnboardSequenceHandlers wiring (seam integration)", () => {
  it("drives heartbeat + timing through the onboarding sequence seam", async () => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    const gatewayPhase = fakePhase("gateway", async () => {
      // Simulate a silent wait that outlives one heartbeat interval.
      harness.clockMs = 30_000;
      harness.timerCallback?.();
      harness.clockMs = 31_000;
      return { context: "ctx", result: "ok" };
    });

    // The reporter is applied inside buildOnboardSequenceHandlers, so the wrapped
    // handler must emit the heartbeat and record timing for the real seam.
    const handlers = buildOnboardSequenceHandlers<string>([gatewayPhase], () => {}, reporter);
    await handlers.gateway?.("ctx");

    expect(
      harness.lines.some((line) =>
        line.includes("⏳ Still working on Gateway startup… (30s elapsed)"),
      ),
    ).toBe(true);
    expect(harness.records[0]).toMatchObject({ phase: "gateway", status: "completed" });
  });

  it("is inert at the seam when the reporter is disabled", async () => {
    const harness = makeHarness({ enabled: false });
    const reporter = createPhaseProgressReporter(harness.options);
    const phase = fakePhase("gateway", async () => ({ context: "ctx", result: "ok" }));
    const handlers = buildOnboardSequenceHandlers<string>([phase], () => {}, reporter);
    await handlers.gateway?.("ctx");
    expect(harness.records).toHaveLength(0);
    expect(harness.lines).toHaveLength(0);
  });
});
