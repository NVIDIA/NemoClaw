// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { startTestProgress, type TestProgressOptions } from "../fixtures/progress.ts";

function progressHarness() {
  const state = {
    baselinePhases: [] as string[],
    clearCalls: 0,
    clockMs: 1_000,
    lines: [] as string[],
    timerCallback: null as (() => void) | null,
  };
  const options: TestProgressOptions = {
    stallThresholdMs: 300_000,
    stallReminderIntervalMs: 600_000,
    now: () => state.clockMs,
    setTimer: (callback) => {
      state.timerCallback = callback;
      return { unref() {} };
    },
    clearTimer: () => {
      state.clearCalls += 1;
    },
    logLine: (line) => state.lines.push(line),
    sampleResources: () => ({
      availableMemoryBytes: 8 * 1024 ** 3,
      processRssBytes: 0.5 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
      workspaceFreeBytes: 6 * 1024 ** 3,
      loadAverage1m: 2.5,
    }),
    sampleResourceEvidence: (phase) => `E2E_RESOURCE_SNAPSHOT {"phase":"${phase}"}`,
    recordResourceBaseline: (phase) => state.baselinePhases.push(phase),
  };
  return { options, state };
}

describe("Hermes rebuild live progress", () => {
  it("keeps runner evidence out of normal phase transitions", () => {
    const { options, state } = progressHarness();
    const progress = startTestProgress(
      "rebuild-hermes",
      ["run authoritative Hermes rebuild", "remove rebuilt Hermes resources"],
      options,
    );

    progress.onOutput({ stream: "stderr", atMs: 61_000 });
    state.clockMs = 301_000;
    state.timerCallback?.();
    progress.phase("remove rebuilt Hermes resources");
    progress.stop();
    const linesAfterStop = state.lines.length;
    progress.stop();
    progress.phase("after stop");

    expect(state.clearCalls).toBe(2);
    expect(state.baselinePhases).toEqual([
      "run authoritative Hermes rebuild",
      "remove rebuilt Hermes resources",
    ]);
    expect(state.lines).toHaveLength(linesAfterStop);
    expect(state.lines).toEqual([
      '[e2e target="unassigned" scenario="rebuild-hermes"] [phase 1/2] started: run authoritative Hermes rebuild (total 0s; phase 0s)',
      '[e2e target="unassigned" scenario="rebuild-hermes"] [phase 1/2] still running: run authoritative Hermes rebuild (total 5m; phase 5m; child output 4m ago; no active command; rss 0.5 GiB; memory available 8.0 GiB/16.0 GiB; disk free 6.0 GiB; load 2.50)',
      'E2E_RESOURCE_SNAPSHOT {"phase":"run authoritative Hermes rebuild"}',
      '[e2e target="unassigned" scenario="rebuild-hermes"] [phase 1/2] completed: run authoritative Hermes rebuild — passed in 5m (total 5m)',
      '[e2e target="unassigned" scenario="rebuild-hermes"] [phase 2/2] started: remove rebuilt Hermes resources (total 5m; phase 0s)',
      '[e2e target="unassigned" scenario="rebuild-hermes"] [phase 2/2] completed: remove rebuilt Hermes resources — passed in 0s (total 5m)',
    ]);
  });

  it("reports a target, scenario, total time, and content-free status events", () => {
    const { options, state } = progressHarness();
    options.targetId = "rebuild-hermes-target";
    const progress = startTestProgress(
      "rebuild-hermes scenario",
      ["pull historical base", "validate rebuilt sandbox"],
      options,
    );

    state.clockMs = 61_000;
    progress.event("historical base pull timed out; retrying attempt 2");
    progress.stop("failed");

    expect(state.lines).toEqual([
      '[e2e target="rebuild-hermes-target" scenario="rebuild-hermes scenario"] [phase 1/2] started: pull historical base (total 0s; phase 0s)',
      '[e2e target="rebuild-hermes-target" scenario="rebuild-hermes scenario"] [phase 1/2] event: historical base pull timed out; retrying attempt 2 (total 1m; phase 1m)',
      '[e2e target="rebuild-hermes-target" scenario="rebuild-hermes scenario"] [phase 1/2] completed: pull historical base — failed in 1m (total 1m)',
    ]);
    expect(() => progress.event("ignored after stop\nsecret-shaped payload")).not.toThrow();

    const activeProgress = startTestProgress(
      "event-validation",
      ["prepare event validation", "finish event validation"],
      { ...options, logLine: () => undefined },
    );
    expect(() => activeProgress.event("invalid\nsecret-shaped payload")).toThrowError(
      /^invalid live E2E progress event label$/u,
    );
    expect(() => activeProgress.activity("invalid\nsecret-shaped payload")).toThrowError(
      /^invalid live E2E progress activity label$/u,
    );
    activeProgress.stop();
  });

  it("labels the portable free-memory fallback honestly in stall evidence", () => {
    const { options, state } = progressHarness();
    options.sampleResources = () => ({
      availableMemoryBytes: 3 * 1024 ** 3,
      memoryAvailabilityKind: "free",
      processRssBytes: 0.5 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
      workspaceFreeBytes: 6 * 1024 ** 3,
      loadAverage1m: 2.5,
    });
    const progress = startTestProgress(
      "rebuild-hermes memory fallback",
      ["run authoritative Hermes rebuild", "remove rebuilt Hermes resources"],
      options,
    );

    state.clockMs = 301_000;
    state.timerCallback?.();
    progress.stop();

    expect(state.lines.find((line) => line.includes("still running"))).toContain(
      "memory free 3.0 GiB/16.0 GiB",
    );
  });

  it("keeps diagnostics best-effort when host sampling and output fail", () => {
    const { options, state } = progressHarness();
    options.logLine = vi.fn(() => {
      throw new Error("closed output");
    });
    options.sampleResources = () => {
      throw new Error("statfs unavailable");
    };

    expect(() => {
      const progress = startTestProgress(
        "rebuild-hermes",
        ["build previous Hermes base", "remove previous Hermes base"],
        options,
      );
      state.clockMs = 301_000;
      state.timerCallback?.();
      progress.phase("remove previous Hermes base");
      progress.stop();
    }).not.toThrow();
    expect(state.clearCalls).toBe(2);
  });
});
