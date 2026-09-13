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
      "run authoritative Hermes rebuild",
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
    expect(state.lines.map((line) => (line.startsWith("{") ? JSON.parse(line) : line))).toEqual([
      {
        kind: "e2e-progress",
        target: "unassigned",
        scenario: "rebuild-hermes",
        event: "start",
        activity: "run authoritative Hermes rebuild",
        elapsedMs: 0,
        activityElapsedMs: 0,
      },
      {
        kind: "e2e-progress",
        target: "unassigned",
        scenario: "rebuild-hermes",
        event: "stall",
        activity: "run authoritative Hermes rebuild",
        elapsedMs: 300000,
        activityElapsedMs: 300000,
        outputAgeMs: 240000,
        activeCommands: [],
        resources: {
          availableMemoryBytes: 8589934592,
          processRssBytes: 536870912,
          totalMemoryBytes: 17179869184,
          workspaceFreeBytes: 6442450944,
          loadAverage1m: 2.5,
        },
      },
      'E2E_RESOURCE_SNAPSHOT {"phase":"run authoritative Hermes rebuild"}',
      {
        kind: "e2e-progress",
        target: "unassigned",
        scenario: "rebuild-hermes",
        event: "complete",
        outcome: "passed",
        durationMs: 300000,
        activity: "run authoritative Hermes rebuild",
        elapsedMs: 300000,
        activityElapsedMs: 300000,
      },
      {
        kind: "e2e-progress",
        target: "unassigned",
        scenario: "rebuild-hermes",
        event: "start",
        activity: "remove rebuilt Hermes resources",
        elapsedMs: 300000,
        activityElapsedMs: 0,
      },
      {
        kind: "e2e-progress",
        target: "unassigned",
        scenario: "rebuild-hermes",
        event: "complete",
        outcome: "passed",
        durationMs: 0,
        activity: "remove rebuilt Hermes resources",
        elapsedMs: 300000,
        activityElapsedMs: 0,
      },
    ]);
  });

  it("reports a target, scenario, total time, and content-free status events", () => {
    const { options, state } = progressHarness();
    options.targetId = "rebuild-hermes-target";
    const progress = startTestProgress("rebuild-hermes scenario", "pull historical base", options);

    state.clockMs = 61_000;
    progress.event("historical base pull timed out; retrying attempt 2");
    progress.stop("failed");

    expect(state.lines.map((line) => (line.startsWith("{") ? JSON.parse(line) : line))).toEqual([
      {
        kind: "e2e-progress",
        target: "rebuild-hermes-target",
        scenario: "rebuild-hermes scenario",
        event: "start",
        activity: "pull historical base",
        elapsedMs: 0,
        activityElapsedMs: 0,
      },
      {
        kind: "e2e-progress",
        target: "rebuild-hermes-target",
        scenario: "rebuild-hermes scenario",
        event: "message",
        message: "historical base pull timed out; retrying attempt 2",
        activity: "pull historical base",
        elapsedMs: 60000,
        activityElapsedMs: 60000,
      },
      {
        kind: "e2e-progress",
        target: "rebuild-hermes-target",
        scenario: "rebuild-hermes scenario",
        event: "complete",
        outcome: "failed",
        durationMs: 60000,
        activity: "pull historical base",
        elapsedMs: 60000,
        activityElapsedMs: 60000,
      },
    ]);
    expect(() => progress.event("ignored after stop\nsecret-shaped payload")).not.toThrow();

    const activeProgress = startTestProgress("event-validation", "prepare event validation", {
      ...options,
      logLine: () => undefined,
    });
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
      "run authoritative Hermes rebuild",
      options,
    );

    state.clockMs = 301_000;
    state.timerCallback?.();
    progress.stop();

    expect(
      state.lines
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .find((entry) => entry.event === "stall").resources,
    ).toMatchObject({
      memoryAvailabilityKind: "free",
      availableMemoryBytes: 3 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
    });
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
      const progress = startTestProgress("rebuild-hermes", "build previous Hermes base", options);
      state.clockMs = 301_000;
      state.timerCallback?.();
      progress.phase("remove previous Hermes base");
      progress.stop();
    }).not.toThrow();
    expect(state.clearCalls).toBe(2);
  });
});
