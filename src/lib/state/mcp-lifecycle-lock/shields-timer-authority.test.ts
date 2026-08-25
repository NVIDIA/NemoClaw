// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isShieldsTimerDeadlineAbandoned,
  readShieldsTimerMarker,
  shieldsTimerMarkerPath,
} from "./shields-timer-authority";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function writeMarker(stateDir: string, requestedSandbox: string, markerSandbox: string): void {
  fs.writeFileSync(
    shieldsTimerMarkerPath(requestedSandbox, stateDir),
    JSON.stringify({
      pid: process.pid,
      restoreAt: "2026-08-03T12:00:00.000Z",
      sandboxName: markerSandbox,
      snapshotPath: path.join(stateDir, "snapshot.yaml"),
    }),
  );
}

describe("Shields timer marker authority", () => {
  it("accepts a marker bound to the requested sandbox", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    writeMarker(stateDir, "alpha", "alpha");

    expect(readShieldsTimerMarker("alpha", stateDir)).toMatchObject({ sandboxName: "alpha" });
  });

  it("rejects a marker whose payload names another sandbox", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    writeMarker(stateDir, "alpha", "beta");

    expect(readShieldsTimerMarker("alpha", stateDir)).toBeNull();
  });
});

describe("abandoned Shields timer deadlines", () => {
  function writeExpiringMarker(
    stateDir: string,
    restoreAt: string,
    extra: Record<string, unknown> = {},
  ): void {
    fs.writeFileSync(
      shieldsTimerMarkerPath("alpha", stateDir),
      JSON.stringify({
        pid: 4321,
        processToken: "a".repeat(32),
        restoreAt,
        sandboxName: "alpha",
        snapshotPath: path.join(stateDir, "snapshot.yaml"),
        ...extra,
      }),
    );
  }

  function stateDirWithMarker(restoreAt: string): string {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    writeExpiringMarker(stateDir, restoreAt);
    return stateDir;
  }

  const past = "2026-08-03T12:00:00.000Z";
  const now = Date.parse("2026-08-03T12:00:01.000Z");

  it("reports a departed timer process past its restore deadline", () => {
    const stateDir = stateDirWithMarker(past);

    expect(
      isShieldsTimerDeadlineAbandoned("alpha", stateDir, now, { processIsAlive: () => false }),
    ).toBe(true);
  });

  it("keeps a live timer process fail-closed", () => {
    const stateDir = stateDirWithMarker(past);

    expect(
      isShieldsTimerDeadlineAbandoned("alpha", stateDir, now, { processIsAlive: () => true }),
    ).toBe(false);
  });

  it("ignores a timer that has not reached its restore deadline", () => {
    const stateDir = stateDirWithMarker("2026-08-03T13:00:00.000Z");

    expect(
      isShieldsTimerDeadlineAbandoned("alpha", stateDir, now, { processIsAlive: () => false }),
    ).toBe(false);
  });

  it("ignores a sandbox with no timer marker", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);

    expect(
      isShieldsTimerDeadlineAbandoned("alpha", stateDir, now, { processIsAlive: () => false }),
    ).toBe(false);
  });

  it("treats a live PID as abandoned when the recorded start identity no longer matches", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    writeExpiringMarker(stateDir, past, { timerProcessStartIdentity: "proc:111" });

    expect(
      isShieldsTimerDeadlineAbandoned("alpha", stateDir, now, {
        processIsAlive: () => true,
        readProcessStartIdentity: () => "proc:222",
      }),
    ).toBe(true);
  });

  it("keeps a live PID closed when its start identity cannot be read", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    writeExpiringMarker(stateDir, past, { timerProcessStartIdentity: "proc:111" });

    expect(
      isShieldsTimerDeadlineAbandoned("alpha", stateDir, now, {
        processIsAlive: () => true,
        readProcessStartIdentity: () => null,
      }),
    ).toBe(false);
  });
});
