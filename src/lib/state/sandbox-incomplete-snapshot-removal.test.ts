// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeIncompleteSnapshot } from "./sandbox.js";

const testDirectories: string[] = [];

function createSnapshot(): string {
  const backupPath = mkdtempSync(join(tmpdir(), "nemoclaw-incomplete-snapshot-"));
  testDirectories.push(backupPath);
  mkdirSync(join(backupPath, "workspace"), { recursive: true });
  writeFileSync(join(backupPath, "rebuild-manifest.json"), "{}");
  return backupPath;
}

afterEach(() => {
  for (const testDirectory of testDirectories.splice(0)) {
    rmSync(testDirectory, { recursive: true, force: true });
  }
});

describe("incomplete snapshot removal", () => {
  it("takes the snapshot and its captured content off disk", () => {
    const backupPath = createSnapshot();

    expect(removeIncompleteSnapshot(backupPath)).toEqual({ removed: true });
    expect(existsSync(backupPath)).toBe(false);
  });

  it("reports success for a snapshot that is already gone", () => {
    const backupPath = createSnapshot();
    rmSync(backupPath, { recursive: true, force: true });

    expect(removeIncompleteSnapshot(backupPath)).toEqual({ removed: true });
  });

  it("reports the reason when removal throws", () => {
    const backupPath = createSnapshot();

    const result = removeIncompleteSnapshot(backupPath, {
      removeBackup: () => {
        throw new Error("EACCES: permission denied");
      },
    });

    expect(result).toEqual({ removed: false, error: "EACCES: permission denied" });
    expect(existsSync(backupPath)).toBe(true);
  });

  it("reports failure when removal reports success but the snapshot remains", () => {
    const backupPath = createSnapshot();

    const result = removeIncompleteSnapshot(backupPath, {
      removeBackup: () => undefined,
    });

    expect(result).toEqual({
      removed: false,
      error: "the snapshot directory still exists after removal",
    });
    expect(existsSync(backupPath)).toBe(true);
  });
});
