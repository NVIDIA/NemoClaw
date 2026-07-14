// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  type RebuildHermesProgressOptions,
  startRebuildHermesProgress,
} from "../live/rebuild-hermes-progress.ts";

function progressHarness() {
  const state = {
    clearCalls: 0,
    clockMs: 1_000,
    lines: [] as string[],
    timerCallback: null as (() => void) | null,
  };
  const options: RebuildHermesProgressOptions = {
    heartbeatIntervalMs: 60_000,
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
      freeMemoryBytes: 8 * 1024 ** 3,
      processRssBytes: 0.5 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
      workspaceFreeBytes: 6 * 1024 ** 3,
      loadAverage1m: 2.5,
    }),
  };
  return { options, state };
}

describe("Hermes rebuild live progress", () => {
  it("streams timestamp-only phase and resource heartbeats through cleanup", () => {
    const { options, state } = progressHarness();
    const progress = startRebuildHermesProgress("phase 6 nemoclaw rebuild", options);

    progress.onOutput({ stream: "stderr", atMs: 21_000 });
    state.clockMs = 61_000;
    state.timerCallback?.();
    progress.phase("cleanup");
    progress.stop();
    const linesAfterStop = state.lines.length;
    progress.stop();
    progress.phase("after stop");

    expect(state.clearCalls).toBe(1);
    expect(state.lines).toHaveLength(linesAfterStop);
    expect(state.lines).toEqual([
      "[rebuild-hermes] phase 6 nemoclaw rebuild started (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[rebuild-hermes] phase 6 nemoclaw rebuild running (60s elapsed; last child output 40s ago; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[rebuild-hermes] phase 6 nemoclaw rebuild finished (60s elapsed; last child output 40s ago; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[rebuild-hermes] cleanup started (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
      "[rebuild-hermes] cleanup finished (0s elapsed; no child output observed; memory free 8.0 GiB/16.0 GiB; test RSS 0.5 GiB; workspace free 6.0 GiB; load 1m 2.50)",
    ]);
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
      const progress = startRebuildHermesProgress("phase 2 old base build", options);
      progress.phase("cleanup");
      progress.stop();
    }).not.toThrow();
    expect(state.clearCalls).toBe(1);
  });
});
