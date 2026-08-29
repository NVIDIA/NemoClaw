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
    vi.restoreAllMocks();
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

  it("restores the completed marker for retry when its unlink fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "timer-marker-unlink-failure-"));
    vi.stubEnv("HOME", home);
    const expected = marker("alpha", "c".repeat(32));
    const markerPath = timerMarkerPath("alpha");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(expected));
    const realUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync")
      .mockImplementationOnce(() => {
        const error = new Error("injected unlink failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      })
      .mockImplementation(realUnlink);

    expect(clearTimerMarkerGeneration("alpha", expected)).toMatchObject({
      cleared: false,
      warning: expect.stringContaining("restored it for retry"),
    });
    expect(readTimerMarker("alpha")).toEqual(expected);
    expect(
      fs.readdirSync(path.dirname(markerPath)).filter((name) => name.includes(".completed-")),
    ).toEqual([]);
    expect(clearTimerMarkerGeneration("alpha", expected)).toEqual({ cleared: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("restores the exact artifact and requires retry when directory sync fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "timer-marker-fsync-failure-"));
    vi.stubEnv("HOME", home);
    const expected = marker("alpha", "d".repeat(32));
    const markerPath = timerMarkerPath("alpha");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(expected));
    const realFsync = fs.fsyncSync.bind(fs);
    let injected = false;
    const injectFsyncFailure = (): never => {
      injected = true;
      const error = new Error("injected directory sync failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    };
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) =>
      injected ? realFsync(fd) : injectFsyncFailure(),
    );

    expect(clearTimerMarkerGeneration("alpha", expected)).toMatchObject({
      cleared: false,
      retainedPath: markerPath,
      retryRequired: true,
      warning: expect.stringContaining("restored it for an explicit retry"),
    });
    expect(readTimerMarker("alpha")).toEqual(expected);
    expect(clearTimerMarkerGeneration("alpha", expected)).toEqual({ cleared: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
