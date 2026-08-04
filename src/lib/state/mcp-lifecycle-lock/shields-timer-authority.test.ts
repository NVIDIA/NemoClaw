// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readShieldsTimerMarker, shieldsTimerMarkerPath } from "./shields-timer-authority";

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
