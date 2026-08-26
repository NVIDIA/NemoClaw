// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname } from "node:path";

// Ownership is checked unconditionally, not only when the directory's mode
// bits show group/other write access: a POSIX ACL can grant another
// account write authority over a directory whose traditional mode bits
// show none, and Node's fs.Stats does not expose ACL entries at all — mode
// bits alone are not proof of who can actually write here. Any owner other
// than the current user or root retains full authority to rename or
// replace our entries no matter what wrote them, at any point, including
// after createTarball() has already returned and the caller has moved on.
// A directory whose mode bits additionally show group/other write access
// also needs the sticky bit (mode 1777, as on a standard /tmp): sticky
// semantics are what stop accounts OTHER than the trusted owner just
// established above from touching entries they don't own. Refusing to
// stage into anything else is the one check here that closes the race for
// good instead of narrowing it.
const MODE_GROUP_OR_OTHER_WRITABLE = 0o022;
const MODE_STICKY = 0o1000;
const ROOT_UID = 0;

function outputDirectoryTrustworthy(outputPath: string): boolean {
  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(dirname(outputPath));
  } catch {
    // Missing or inaccessible parent: let the real staging attempt below
    // fail with its own, more specific error instead of a generic refusal.
    return true;
  }
  if (typeof process.getuid === "function") {
    const currentUid = process.getuid();
    if (dirStat.uid !== currentUid && dirStat.uid !== ROOT_UID) return false;
  }
  const writableByOthers = (dirStat.mode & MODE_GROUP_OR_OTHER_WRITABLE) !== 0;
  if (!writableByOthers) return true;
  return (dirStat.mode & MODE_STICKY) !== 0;
}

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
  // Everything below assumes the output directory itself isn't a shared
  // space another local account can rename or delete our entries in — see
  // outputDirectoryTrustworthy(). Without that precondition, an attacker
  // could always win by acting after this function has already returned
  // and the caller has moved on, which nothing inside createTarball() can
  // detect or prevent (#10195).
  if (!outputDirectoryTrustworthy(output)) {
    error(
      `Refusing to stage a tarball under ${dirname(output)}: another local account may be able ` +
        "to rename or replace a file placed here, at any point, including after this command " +
        "reports success — either because it owns the directory, or because it can write to " +
        "it without the sticky bit set to protect entries it doesn't own. Choose a directory " +
        "owned by this account (or root) that either isn't writable by other accounts, or has " +
        "the sticky bit set (mode 1777, as on a standard /tmp).",
    );
    process.exitCode = 1;
    return false;
  }
  // Claim the predictable staging path and hold the descriptor for the whole
  // write: O_EXCL refuses a path another local user pre-planted (file or
  // symlink). tar streams to stdout redirected into this descriptor, and the
  // mode is set with fchmod on the same descriptor, so no step after the
  // claim reopens the path by name. The final rename is checked against the
  // held descriptor's identity both before and after it runs. Combined with
  // the directory check above, an attacker without the standing ability to
  // remove another user's entries — which the check just ruled out — can
  // never make us report success for, publish, or write through a planted
  // symlink (#10195).
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
    // rename() is pathname-based and never follows its source, so it cannot
    // be tricked into writing through a symlink — but it also cannot tell a
    // swapped path from the real one. Without any check here, an attacker
    // who swaps `partial` for a symlink after we opened it would have that
    // link renamed to `output`: createTarball() would report success and
    // the caller's own "attach this to your GitHub issue" guidance would
    // point at attacker-chosen content instead of the archive we actually
    // wrote. The still-open descriptor's identity never changes no matter
    // what path points at it, so it is the one thing here a swapped path
    // can't fake — compare against it both before rename (cheap fast path
    // that skips ever touching `output` in the common case) and after
    // (Node's fs API has no rename-by-descriptor, so the pathname-based
    // pre-check and the rename itself are two separate calls and cannot be
    // made atomic with each other; verifying again afterward closes that
    // narrow remaining window instead of merely narrowing it). A mismatch
    // at either point means the path no longer named the file we wrote to,
    // so publication fails closed and any wrongly published content is
    // removed, rather than ever reporting success for it.
    const heldStat = fstatSync(fd);
    const partialStat = lstatSync(partial);
    if (partialStat.dev !== heldStat.dev || partialStat.ino !== heldStat.ino) {
      error(
        `Refusing to publish ${output}: the staged path ${partial} was replaced before it could be moved into place.`,
      );
      return false;
    }
    renameSync(partial, output);
    const outputStat = lstatSync(output);
    if (outputStat.dev !== heldStat.dev || outputStat.ino !== heldStat.ino) {
      error(
        `Refusing to report success for ${output}: its content no longer matches the archive that was staged.`,
      );
      try {
        rmSync(output, { force: true });
      } catch (cleanupErr) {
        error(
          `Additionally failed to remove the untrusted content left at ${output}: ` +
            `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}. ` +
            "Remove it by hand before reusing this path.",
        );
      }
      return false;
    }
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
      } catch (cleanupErr) {
        error(
          `Additionally failed to remove the leftover partial archive at ${partial}: ` +
            `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}. ` +
            "It may contain collected diagnostics; remove it by hand before retrying.",
        );
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
