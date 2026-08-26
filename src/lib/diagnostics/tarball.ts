// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync, renameSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";

export interface CreateTarballOptions {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  /** Timeout for the underlying `tar` invocation. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/**
 * Archive `collectDir` into a tarball at `output`. Writes to a sibling
 * `.partial.<pid>` path and renames atomically on success so a pre-existing
 * file at `output` is preserved when `tar` fails. Sets `process.exitCode = 1`
 * on failure so callers do not have to remember.
 */
export function createTarball(
  collectDir: string,
  output: string,
  options: CreateTarballOptions,
): boolean {
  const { info, warn, error, timeoutMs = 60_000 } = options;
  const partial = `${output}.partial.${process.pid}`;
  // Claim the predictable staging path and hold the descriptor for the whole
  // write: O_EXCL refuses a path another local user pre-planted (file or
  // symlink). tar streams to stdout redirected into this descriptor, and the
  // mode is set with fchmod on the same descriptor, so no step after the
  // claim reopens the path by name. An attacker who can unlink entries in
  // the output directory can still make the final rename fail or misplace
  // the bundle (denial of service), but can never make us write through a
  // planted symlink (#10195).
  let fd: number;
  try {
    fd = openSync(
      partial,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    error(
      `Failed to stage tarball at ${partial}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return false;
  }
  let staged = false;
  try {
    const result = spawnSync(
      "tar",
      ["czf", "-", "-C", dirname(collectDir), basename(collectDir)],
      {
        stdio: ["ignore", fd, "inherit"],
        timeout: timeoutMs,
      },
    );
    if (result.status !== 0 || result.signal) {
      const reason = result.signal
        ? `killed by signal ${result.signal}`
        : `exited with code ${result.status ?? "unknown"}`;
      error(`Failed to create tarball at ${output} (tar ${reason})`);
      return false;
    }
    fchmodSync(fd, 0o600);
    // rename() never follows the source: if the staging path was swapped for
    // a symlink after we opened it, this moves the symlink itself, leaving
    // our written data orphaned under `partial` rather than publishing
    // through the link. Worst case is a failed/misplaced bundle, not a write
    // through an attacker's symlink.
    renameSync(partial, output);
    staged = true;
  } catch (err) {
    error(
      `Failed to move tarball into place at ${output}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort close of staging descriptor */
    }
    if (!staged) {
      process.exitCode = 1;
      try {
        rmSync(partial, { force: true });
      } catch {
        /* best-effort cleanup of partial tarball */
      }
    }
  }
  info(`Tarball written to ${output}`);
  warn(
    "Known secrets are auto-redacted, but please review for any remaining sensitive data before sharing.",
  );
  info("Attach this file to your GitHub issue.");
  return true;
}
