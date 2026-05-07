// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Post-upgrade stale-file cleanup.
//
// As NemoClaw evolves, host-side state migrates: older versions wrote files
// under the user's home that newer versions no longer use. Each entry in
// STALE_FILES owns the safety logic for one specific stale file and reports
// back when it actually removed something. The runner invokes them all once
// during the onboard completion path so a fresh post-upgrade onboard sweeps
// every leftover in a single uniform pass. Adding a future cleanup is one
// entry on STALE_FILES; the loop does not change. If a future leftover is a
// folder or symlink instead of a file, widen the shape at that point.

import { removeLegacyCredentialsFileIfEmpty } from "./credentials";

interface StaleHostFile {
  /** Human-readable description for the success log line. */
  readonly description: string;
  /**
   * Atomically inspect-and-remove the file iff its safety guards
   * permit it. Returns true iff the file was actually removed.
   * Splitting "is-removable?" from "remove" would be TOCTOU-unsafe,
   * so each entry exposes a single combined operation.
   */
  readonly tryRemove: () => boolean;
}

const STALE_FILES: readonly StaleHostFile[] = [
  {
    description: "~/.nemoclaw/credentials.json (no migratable credentials)",
    tryRemove: removeLegacyCredentialsFileIfEmpty,
  },
];

/**
 * Sweep every registered stale host file left behind by older NemoClaw
 * versions. Best-effort: a failure inside one entry is logged to stderr
 * but never aborts the others or the surrounding onboard. Logs a single
 * line to stdout per file actually removed so the user can audit what
 * changed. Safe to call after a successful onboard regardless of which
 * migration paths fired earlier — every entry is a no-op when its
 * target doesn't exist or doesn't satisfy the entry's safety rules.
 */
export function cleanupStaleHostFiles(): void {
  for (const file of STALE_FILES) {
    try {
      if (file.tryRemove()) {
        console.log(`  Removed stale ${file.description}.`);
      }
    } catch (error) {
      console.error(
        `  Skipped stale-file cleanup ${file.description}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
