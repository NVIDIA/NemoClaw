// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasQuarantinedShieldsTimerRecoveryArtifact,
  hasShieldsTimerRecoveryArtifact,
  isShieldsTimerDeadlineAbandoned,
  readShieldsTimerMarker,
  readShieldsTimerRecoveryCandidate,
  shieldsTimerMarkerPath,
} from "./shields-timer-authority";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
  it("distinguishes canonical and quarantined recovery artifacts", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    const markerPath = shieldsTimerMarkerPath("alpha", stateDir);
    writeMarker(stateDir, "alpha", "alpha");

    expect(hasShieldsTimerRecoveryArtifact("alpha", stateDir)).toBe(true);
    expect(hasQuarantinedShieldsTimerRecoveryArtifact("alpha", stateDir)).toBe(false);

    fs.renameSync(markerPath, `${markerPath}.completed-test`);

    expect(hasShieldsTimerRecoveryArtifact("alpha", stateDir)).toBe(true);
    expect(hasQuarantinedShieldsTimerRecoveryArtifact("alpha", stateDir)).toBe(true);
  });

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

  it("leaves invalid sandbox tokens to command validation", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);

    expect(hasShieldsTimerRecoveryArtifact("alpha;echo pwned", stateDir)).toBe(false);
  });

  it("rejects a hard-linked recovery marker", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    const markerPath = shieldsTimerMarkerPath("alpha", stateDir);
    writeMarker(stateDir, "alpha", "alpha");
    fs.linkSync(markerPath, path.join(stateDir, "linked-marker.json"));

    expect(readShieldsTimerMarker("alpha", stateDir)).toBeNull();
    expect(() => readShieldsTimerRecoveryCandidate("alpha", stateDir)).toThrow(
      /recovery artifacts are invalid/,
    );
  });

  it("rejects a recovery marker replaced during its read", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    const markerPath = shieldsTimerMarkerPath("alpha", stateDir);
    const openedPath = path.join(stateDir, "opened-marker.json");
    writeMarker(stateDir, "alpha", "alpha");
    const originalReadSync = fs.readSync.bind(fs);
    vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
      fs.renameSync(markerPath, openedPath);
      writeMarker(stateDir, "alpha", "alpha");
      return Reflect.apply(originalReadSync, fs, args);
    }) as typeof fs.readSync);

    expect(() => readShieldsTimerRecoveryCandidate("alpha", stateDir)).toThrow(
      /recovery artifacts are invalid/,
    );
  });

  it("escapes terminal control characters in recovery artifact diagnostics", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    const markerPath = shieldsTimerMarkerPath("alpha", stateDir);
    writeMarker(stateDir, "alpha", "alpha");
    const hostilePath = `${markerPath}.completed-hostile\u001b[31m\n\u009b31m\u202e\u2066`;
    fs.renameSync(markerPath, hostilePath);
    fs.writeFileSync(`${markerPath}.completed-invalid`, "{}");

    let message = "";
    try {
      readShieldsTimerRecoveryCandidate("alpha", stateDir);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("\\u001b");
    expect(message).toContain("\\n");
    expect(message).toContain("\\u009b");
    expect(message).toContain("\\u202e");
    expect(message).toContain("\\u2066");
    expect(message).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
  });

  it("fails into recovery with terminal-safe directory inspection diagnostics", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-marker-"));
    tempDirs.push(stateDir);
    const error = new Error(
      `cannot inspect ${stateDir}\u001b[31m\n\u009b31m\u202e\u2066`,
    ) as NodeJS.ErrnoException;
    error.code = "EACCES";
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw error;
    });

    expect(hasShieldsTimerRecoveryArtifact("alpha", stateDir)).toBe(true);

    let message = "";
    try {
      readShieldsTimerRecoveryCandidate("alpha", stateDir);
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain("could not inspect artifacts");
    expect(message).toContain("\\u001b");
    expect(message).toContain("\\n");
    expect(message).toContain("\\u009b");
    expect(message).toContain("\\u202e");
    expect(message).toContain("\\u2066");
    expect(message).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
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
