// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** The snapshot directory grammar that the retention commands accept. */
export const SNAPSHOT_DIR_NAME_RE = /^\d{8}T\d{6}Z$/;

/** A UTC instant in the snapshot directory grammar: 20260818T064316Z. */
export function compactUtcTimestamp(at: number = Date.now()): string {
  return new Date(at).toISOString().replace(/[-:]|\.\d+(?=Z)/g, "");
}

/**
 * Reserve one snapshot directory for the calling operation alone.
 *
 * The leaf mkdir is non-recursive, so the reservation is a single atomic syscall: EEXIST means
 * some other snapshot already owns that second, and the caller never writes into, or cleans up, a
 * directory it did not create. The grammar above is second-resolution, so a taken second advances
 * to the next second rather than taking a suffix the retention reader would reject. Each attempt
 * names a later second than the last, so the loop ends at the first unused one.
 *
 * A non-directory entry planted at a candidate name, including a symlink, also fails with EEXIST,
 * so reservation advances past it instead of following it.
 */
export function reserveSnapshotDir(snapshotsDir: string, startedAt: number = Date.now()): string {
  mkdirSync(snapshotsDir, { recursive: true });
  for (let at = startedAt; ; at += 1000) {
    const candidate = join(snapshotsDir, compactUtcTimestamp(at));
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
