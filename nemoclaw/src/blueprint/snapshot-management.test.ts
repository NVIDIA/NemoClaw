// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deleteSnapshot,
  isSnapshotPathInsideSnapshotsDir,
  listSnapshots,
  pruneSnapshots,
} from "./snapshot-management.js";

const tempRoots: string[] = [];
const REAL_TMP = fs.realpathSync(os.tmpdir());

function writeSnapshot(
  snapshotsDir: string,
  timestamp: string,
  options: { manifestTimestamp?: string; source?: string } = {},
): string {
  const snapshotDir = path.join(snapshotsDir, timestamp);
  fs.mkdirSync(path.join(snapshotDir, "openclaw"), { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "openclaw", "config.json"), "{}\n");
  fs.writeFileSync(
    path.join(snapshotDir, "snapshot.json"),
    JSON.stringify({
      timestamp: options.manifestTimestamp ?? timestamp,
      source: options.source ?? path.join(REAL_TMP, "openclaw-source"),
      file_count: 1,
      contents: ["config.json"],
    }),
  );
  return snapshotDir;
}

function temporaryHome(): { home: string; snapshotsDir: string } {
  const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-management-"));
  tempRoots.push(home);
  return { home, snapshotsDir: path.join(home, ".nemoclaw", "snapshots") };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("snapshot retention management", () => {
  it("lists strict snapshot identities newest first", async () => {
    const { snapshotsDir } = temporaryHome();
    const older = writeSnapshot(snapshotsDir, "20990101T000000Z");
    const newer = writeSnapshot(snapshotsDir, "20990201T000000Z");

    expect(listSnapshots({ snapshotsDir })).toEqual([
      expect.objectContaining({ timestamp: "20990201T000000Z", path: newer }),
      expect.objectContaining({ timestamp: "20990101T000000Z", path: older }),
    ]);
  });

  it("ignores mutable manifest timestamps that disagree with directory identity", async () => {
    const { snapshotsDir } = temporaryHome();
    const mismatched = writeSnapshot(snapshotsDir, "20990101T000000Z", {
      manifestTimestamp: "20990301T000000Z",
    });
    const trusted = writeSnapshot(snapshotsDir, "20990201T000000Z");

    expect(listSnapshots({ snapshotsDir }).map((snapshot) => snapshot.path)).toEqual([trusted]);
    expect(pruneSnapshots(1, { snapshotsDir })).toEqual({
      deleted: [],
      kept: [trusted],
      failed: [],
    });
    expect(fs.existsSync(mismatched)).toBe(true);
  });

  it("skips malformed directories, manifests, and non-directory entries", async () => {
    const { snapshotsDir } = temporaryHome();
    writeSnapshot(snapshotsDir, "not-a-snapshot");
    const corrupt = path.join(snapshotsDir, "20990101T000000Z");
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(path.join(corrupt, "snapshot.json"), "not json");
    fs.writeFileSync(path.join(snapshotsDir, "20990201T000000Z"), "not a directory");

    expect(listSnapshots({ snapshotsDir })).toEqual([]);
  });

  it("constrains deletion to a strict direct-child snapshot path", async () => {
    const { snapshotsDir } = temporaryHome();
    fs.mkdirSync(snapshotsDir, { recursive: true });

    expect(deleteSnapshot("/tmp/unauthorized", { snapshotsDir })).toBe(false);
    expect(deleteSnapshot(snapshotsDir, { snapshotsDir })).toBe(false);
    expect(deleteSnapshot(path.join(snapshotsDir, "not-a-snapshot"), { snapshotsDir })).toBe(false);
    expect(isSnapshotPathInsideSnapshotsDir(snapshotsDir, { snapshotsDir })).toBe(false);
  });

  it("treats a missing child under a verified snapshots root as already deleted", async () => {
    const { snapshotsDir } = temporaryHome();
    fs.mkdirSync(snapshotsDir, { recursive: true });

    expect(deleteSnapshot(path.join(snapshotsDir, "20990101T000000Z"), { snapshotsDir })).toBe(
      true,
    );
  });

  it("fails closed when the isolated deletion helper cannot launch", async () => {
    const { snapshotsDir } = temporaryHome();
    const snapshot = writeSnapshot(snapshotsDir, "20990101T000000Z");

    expect(deleteSnapshot(snapshot, { snapshotsDir, deleteDirectory: () => false })).toBe(false);
    expect(fs.existsSync(snapshot)).toBe(true);
  });

  it("keeps the newest snapshots and deletes the rest", async () => {
    const { snapshotsDir } = temporaryHome();
    const oldest = writeSnapshot(snapshotsDir, "20990101T000000Z");
    const middle = writeSnapshot(snapshotsDir, "20990201T000000Z");
    const newest = writeSnapshot(snapshotsDir, "20990301T000000Z");

    expect(pruneSnapshots(2, { snapshotsDir })).toEqual({
      deleted: [oldest],
      kept: [newest, middle],
      failed: [],
    });
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
  });

  it("reports real helper failures while preserving the requested keep set", async () => {
    const { snapshotsDir } = temporaryHome();
    const older = writeSnapshot(snapshotsDir, "20990101T000000Z");
    const newer = writeSnapshot(snapshotsDir, "20990201T000000Z");

    expect(pruneSnapshots(1, { snapshotsDir, deleteDirectory: () => false })).toEqual({
      deleted: [],
      kept: [newer],
      failed: [older],
    });
    expect(fs.existsSync(older)).toBe(true);
    expect(fs.existsSync(newer)).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN])("rejects invalid keep value %s", async (keep) => {
    const { snapshotsDir } = temporaryHome();

    expect(() => pruneSnapshots(keep, { snapshotsDir })).toThrow(
      "--keep must be a non-negative integer",
    );
  });
});
