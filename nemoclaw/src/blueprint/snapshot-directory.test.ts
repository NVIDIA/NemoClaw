// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compactUtcTimestamp,
  reserveSnapshotDir,
  SNAPSHOT_DIR_NAME_RE,
} from "./snapshot-directory.js";

// macOS resolves the default TMPDIR through a /var symlink, which the snapshot delete helper
// rejects. Other platforms can use their native temporary directory.
const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const roots: string[] = [];

function makeSnapshotsDir(): string {
  const root = mkdtempSync(join(temporaryRoot, "nemoclaw-snapshot-dir-"));
  roots.push(root);
  return join(root, "snapshots");
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true }));
});

describe("blueprint snapshot directory reservation", () => {
  it("names a reserved directory in the grammar the retention reader accepts", () => {
    const reserved = reserveSnapshotDir(makeSnapshotsDir(), Date.parse("2026-08-18T06:43:16.500Z"));

    expect(basename(reserved)).toBe("20260818T064316Z");
    expect(basename(reserved)).toMatch(SNAPSHOT_DIR_NAME_RE);
    expect(compactUtcTimestamp(Date.parse("2026-08-18T06:43:16.500Z"))).toBe(basename(reserved));
  });

  it("gives a same-second reservation the next unused second (#9433)", () => {
    const snapshotsDir = makeSnapshotsDir();
    const startedAt = Date.parse("2026-08-18T06:43:16.500Z");

    const first = reserveSnapshotDir(snapshotsDir, startedAt);
    writeFileSync(join(first, "reservation-marker"), "first");
    const second = reserveSnapshotDir(snapshotsDir, startedAt);

    expect(basename(first)).toBe("20260818T064316Z");
    expect(basename(second)).toBe("20260818T064317Z");
    expect(basename(second)).toMatch(SNAPSHOT_DIR_NAME_RE);
    // The second reservation owns an empty directory, so it can neither read nor clean up the first.
    expect(second).not.toBe(first);
  });

  it("advances past a planted symlink instead of following it", () => {
    const snapshotsDir = makeSnapshotsDir();
    const startedAt = Date.parse("2026-08-18T06:43:16.500Z");
    reserveSnapshotDir(snapshotsDir, startedAt);
    rmSync(join(snapshotsDir, "20260818T064316Z"), { recursive: true });
    symlinkSync("/etc", join(snapshotsDir, "20260818T064316Z"));

    const reserved = reserveSnapshotDir(snapshotsDir, startedAt);

    expect(basename(reserved)).toBe("20260818T064317Z");
  });
});
