// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync } from "node:fs";
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
 * `.partial.<pid>.<random>` path that this process creates exclusively at mode
 * `0600`, then renames atomically on success so a pre-existing file at `output`
 * is preserved when `tar` fails. Sets `process.exitCode = 1` on failure so
 * callers do not have to remember.
 */
export function createTarball(
  collectDir: string,
  output: string,
  options: CreateTarballOptions,
): boolean {
  const { info, warn, error, timeoutMs = 60_000 } = options;
  // Stage beside `output` under a name other users cannot predict, and create
  // it exclusively at mode 0600 before `tar` runs. The exclusive create refuses
  // to follow anything already at that path, and `tar` truncates the file it
  // finds instead of recreating it, so the published bundle is owner-only
  // rather than umask-governed.
  const partial = `${output}.partial.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    closeSync(openSync(partial, "wx", 0o600));
  } catch (err) {
    error(
      `Failed to stage tarball for ${output}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return false;
  }
  const result = spawnSync(
    "tar",
    ["czf", partial, "-C", dirname(collectDir), basename(collectDir)],
    {
      stdio: "inherit",
      timeout: timeoutMs,
    },
  );
  if (result.status !== 0 || result.signal) {
    const reason = result.signal
      ? `killed by signal ${result.signal}`
      : `exited with code ${result.status ?? "unknown"}`;
    error(`Failed to create tarball at ${output} (tar ${reason})`);
    try {
      rmSync(partial, { force: true });
    } catch {
      /* best-effort cleanup of partial tarball */
    }
    process.exitCode = 1;
    return false;
  }
  try {
    renameSync(partial, output);
  } catch (err) {
    error(
      `Failed to move tarball into place at ${output}: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      rmSync(partial, { force: true });
    } catch {
      /* best-effort */
    }
    process.exitCode = 1;
    return false;
  }
  info(`Tarball written to ${output}`);
  warn(
    "Known secrets are auto-redacted, but please review for any remaining sensitive data before sharing.",
  );
  info("Attach this file to your GitHub issue.");
  return true;
}
