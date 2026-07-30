// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, vi } from "vitest";

export const COMMIT_RECOVERY_INTERRUPTION_POINTS = [
  "during-compact-receipt-write",
  "before-backup-removal",
  "during-backup-removal",
  "after-backup-removal",
  "after-manifest-removal",
] as const;

export type CommitRecoveryInterruption = (typeof COMMIT_RECOVERY_INTERRUPTION_POINTS)[number];

export function installPostRenameCleanupInterruption(): {
  readonly originalRmSync: typeof fs.rmSync;
  readonly restore: () => void;
} {
  const originalRmSync: typeof fs.rmSync = fs.rmSync.bind(fs);
  const rm = vi.spyOn(fs, "rmSync").mockImplementation(((
    target: fs.PathLike,
    removeOptions?: fs.RmDirOptions,
  ) => {
    if (String(target).endsWith(`${path.sep}backups`)) {
      throw new Error("injected post-rename cleanup interruption");
    }
    return originalRmSync(target, removeOptions);
  }) as typeof fs.rmSync);
  return {
    originalRmSync,
    restore: () => rm.mockRestore(),
  };
}

export function applyCommitRecoveryInterruption(
  interruption: CommitRecoveryInterruption,
  committedDirectory: string,
  originalRmSync: typeof fs.rmSync,
): void {
  const backups = path.join(committedDirectory, "backups");
  const manifest = path.join(committedDirectory, "manifest.json");
  if (interruption === "during-compact-receipt-write") {
    fs.renameSync(
      path.join(committedDirectory, "receipt.json"),
      path.join(committedDirectory, ".receipt.json.1234567890abcdef12345678"),
    );
  } else if (interruption === "during-backup-removal") {
    const [firstBackup] = fs.readdirSync(backups);
    expect(firstBackup).toBeTruthy();
    fs.unlinkSync(path.join(backups, firstBackup!));
  } else if (interruption === "after-backup-removal") {
    originalRmSync(backups, { force: false, recursive: true });
  } else if (interruption === "after-manifest-removal") {
    fs.unlinkSync(manifest);
  }
}
