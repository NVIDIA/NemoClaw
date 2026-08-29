// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTimerMarkerGeneration,
  processInspectionDeadlineAfter,
  processInspectionDeadlineReached,
  readTimerMarker,
  timerMarkerPath,
  type TimerMarker,
} from "./timer-control";

describe("process inspection deadlines", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remain bounded when the wall clock moves backward", () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(50_000);
    const deadline = processInspectionDeadlineAfter(500);

    wallClock.mockReturnValue(-50_000);
    monotonicNow.mockReturnValue(1_499);
    expect(processInspectionDeadlineReached(deadline)).toBe(false);

    monotonicNow.mockReturnValue(1_500);
    expect(processInspectionDeadlineReached(deadline)).toBe(true);
  });
});

describe("timer marker generation cleanup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function marker(sandboxName: string, processToken: string): TimerMarker {
    return {
      pid: process.pid,
      sandboxName,
      snapshotPath: "/tmp/snapshot.yaml",
      restoreAt: "2026-01-01T00:00:00.000Z",
      processToken,
    };
  }

  it("removes only the expected completed timer marker", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "timer-marker-cleanup-"));
    vi.stubEnv("HOME", home);
    const expected = marker("alpha", "a".repeat(32));
    const markerPath = timerMarkerPath("alpha");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(expected));

    expect(clearTimerMarkerGeneration("alpha", expected)).toEqual({ cleared: true });
    expect(readTimerMarker("alpha")).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("restores a replacement marker instead of deleting it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "timer-marker-race-"));
    vi.stubEnv("HOME", home);
    const expected = marker("alpha", "a".repeat(32));
    const replacement = marker("alpha", "b".repeat(32));
    const markerPath = timerMarkerPath("alpha");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(replacement));

    expect(clearTimerMarkerGeneration("alpha", expected)).toMatchObject({
      cleared: false,
      warning: expect.stringContaining("authority changed"),
    });
    expect(readTimerMarker("alpha")).toEqual(replacement);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
