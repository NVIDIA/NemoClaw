// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  type RebuildHermesProgressOptions,
  startRebuildHermesProgress,
} from "../live/rebuild-hermes-progress.ts";
import {
  buildRebuildHermesTimingSummary,
  describeRunnerClass,
} from "../live/rebuild-hermes-timing.ts";

function timelineHarness() {
  const state = { clockMs: 1_000 };
  const options: RebuildHermesProgressOptions = {
    now: () => state.clockMs,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    logLine: () => {},
    sampleResources: () => ({
      freeMemoryBytes: 0,
      processRssBytes: 0,
      totalMemoryBytes: 0,
      workspaceFreeBytes: 0,
      loadAverage1m: 0,
    }),
  };
  return { options, state };
}

describe("Hermes rebuild timing timeline", () => {
  it("records each completed phase and closes the in-flight phase on snapshot", () => {
    const { options, state } = timelineHarness();
    const progress = startRebuildHermesProgress("setup", options);

    state.clockMs = 4_000;
    progress.phase("phase 6 nemoclaw rebuild");
    state.clockMs = 9_000;

    expect(progress.timeline()).toEqual({
      phases: [
        { label: "setup", elapsedMs: 3_000 },
        { label: "phase 6 nemoclaw rebuild", elapsedMs: 5_000 },
      ],
      totalMs: 8_000,
    });
  });

  it("freezes the timeline at stop and ignores post-stop transitions", () => {
    const { options, state } = timelineHarness();
    const progress = startRebuildHermesProgress("phase 7 verification", options);

    state.clockMs = 6_000;
    progress.stop();
    state.clockMs = 60_000;
    progress.phase("after stop");

    expect(progress.timeline()).toEqual({
      phases: [{ label: "phase 7 verification", elapsedMs: 5_000 }],
      totalMs: 5_000,
    });
  });

  it("uses the same stop timestamp for the final phase and total", () => {
    const { options } = timelineHarness();
    let clockMs = 1_000;
    options.now = () => {
      const current = clockMs;
      clockMs += 1_000;
      return current;
    };
    const progress = startRebuildHermesProgress("phase 7 verification", options);

    progress.stop();

    expect(progress.timeline()).toEqual({
      phases: [{ label: "phase 7 verification", elapsedMs: 2_000 }],
      totalMs: 2_000,
    });
  });
});

describe("Hermes rebuild timing summary", () => {
  const runnerClass = describeRunnerClass(() => ({
    platform: "linux",
    arch: "x64",
    cpus: [{ model: "  Model A  " }, { model: "Model A" }],
    totalMemoryBytes: 16 * 1024 ** 3,
  }));

  it("derives a runner-class fingerprint from the sampled host", () => {
    expect(runnerClass).toEqual({
      platform: "linux",
      arch: "x64",
      cpuCount: 2,
      cpuModel: "Model A",
      totalMemoryBytes: 16 * 1024 ** 3,
    });
  });

  it("labels the lane and normalizes durations to whole non-negative ms", () => {
    const summary = buildRebuildHermesTimingSummary({
      lane: "stale-base",
      runnerClass,
      capturedAtIso: "2026-07-18T00:00:00.000Z",
      timeline: {
        phases: [
          { label: "setup", elapsedMs: 1_499.6 },
          { label: "phase 6 nemoclaw rebuild", elapsedMs: -5 },
        ],
        totalMs: 12_345.4,
      },
    });

    expect(summary).toEqual({
      schema: 1,
      lane: "stale-base",
      runnerClass,
      phases: [
        { label: "setup", elapsedMs: 1_500 },
        { label: "phase 6 nemoclaw rebuild", elapsedMs: 0 },
      ],
      totalMs: 12_345,
      capturedAtIso: "2026-07-18T00:00:00.000Z",
    });
  });

  it("falls back to a placeholder model when no CPU is reported", () => {
    expect(
      describeRunnerClass(() => ({
        platform: "linux",
        arch: "arm64",
        cpus: [],
        totalMemoryBytes: 0,
      })).cpuModel,
    ).toBe("unknown");
  });
});
