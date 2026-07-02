// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";

import {
  formatPhaseDuration,
  formatPhaseTimingsSummary,
  getPhaseTimings,
  type PhaseTiming,
  recordPhaseTiming,
  resetPhaseTimings,
} from "./phase-timings";

describe("phase timings registry", () => {
  beforeEach(() => {
    resetPhaseTimings();
  });

  it("records timings and returns an immutable snapshot", () => {
    recordPhaseTiming({
      phase: "gateway",
      label: "Gateway startup",
      durationMs: 1000,
      status: "completed",
    });
    const snapshot = getPhaseTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ phase: "gateway", durationMs: 1000, status: "completed" });
    // Mutating the snapshot must not affect the registry (#6002).
    (snapshot as PhaseTiming[]).push({
      phase: "x",
      label: "x",
      durationMs: 1,
      status: "completed",
    });
    expect(getPhaseTimings()).toHaveLength(1);
  });

  it("clamps negative durations to zero", () => {
    recordPhaseTiming({
      phase: "sandbox",
      label: "Sandbox creation",
      durationMs: -50,
      status: "completed",
    });
    expect(getPhaseTimings()[0].durationMs).toBe(0);
  });

  it("resets recorded timings", () => {
    recordPhaseTiming({
      phase: "gateway",
      label: "Gateway startup",
      durationMs: 1000,
      status: "completed",
    });
    resetPhaseTimings();
    expect(getPhaseTimings()).toHaveLength(0);
  });
});

describe("formatPhaseDuration", () => {
  it("renders sub-minute durations in seconds with one decimal", () => {
    expect(formatPhaseDuration(0)).toBe("0.0s");
    expect(formatPhaseDuration(12_340)).toBe("12.3s");
    expect(formatPhaseDuration(59_900)).toBe("59.9s");
  });

  it("renders minute-scale durations as Xm SSs with zero-padded seconds", () => {
    expect(formatPhaseDuration(60_000)).toBe("1m 00s");
    expect(formatPhaseDuration(247_000)).toBe("4m 07s");
  });

  it("rolls a rounded 60s carry into the next minute", () => {
    // 119.6s rounds to 120s -> should read 2m 00s, not 1m 60s.
    expect(formatPhaseDuration(119_600)).toBe("2m 00s");
  });

  it("never produces a negative duration", () => {
    expect(formatPhaseDuration(-1000)).toBe("0.0s");
  });
});

describe("formatPhaseTimingsSummary", () => {
  beforeEach(() => {
    resetPhaseTimings();
  });

  it("returns an empty string when no phases were recorded", () => {
    expect(formatPhaseTimingsSummary()).toBe("");
  });

  it("renders a table with per-phase rows and a total", () => {
    const summary = formatPhaseTimingsSummary([
      { phase: "gateway", label: "Gateway startup", durationMs: 42_000, status: "completed" },
      { phase: "sandbox", label: "Sandbox creation", durationMs: 300_000, status: "completed" },
    ]);
    expect(summary).toContain("Phase timings");
    expect(summary).toContain("✓ Gateway startup");
    expect(summary).toContain("42.0s");
    expect(summary).toContain("Sandbox creation");
    expect(summary).toContain("5m 00s");
    expect(summary).toContain("Total");
    // Total = 42s + 300s = 342s -> 5m 42s
    expect(summary).toContain("5m 42s");
  });

  it("marks failed phases with a cross", () => {
    const summary = formatPhaseTimingsSummary([
      { phase: "inference", label: "Inference setup", durationMs: 8_000, status: "failed" },
    ]);
    expect(summary).toContain("✗ Inference setup");
  });

  it("reads the module registry when no timings are passed", () => {
    recordPhaseTiming({
      phase: "gateway",
      label: "Gateway startup",
      durationMs: 7_000,
      status: "completed",
    });
    expect(formatPhaseTimingsSummary()).toContain("Gateway startup");
  });
});
