// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface CreateTarballOptions {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  /** Timeout for the underlying `tar` invocation. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/**
 * Archive `collectDir` into a tarball at `output`. Writes through an open
 * descriptor inside an owner-only sibling directory, then renames atomically on
 * success. A pre-existing file at `output` is preserved when `tar` fails.
 * Sets `process.exitCode = 1` on failure so callers do not have to remember.
 */
export function createTarball(
  collectDir: string,
  output: string,
  options: CreateTarballOptions,
): boolean {
  const { info, warn, error, timeoutMs = 60_000 } = options;
  // The owner-only directory prevents another local user from replacing the
  // archive path after this process creates it. Keep the descriptor open and
  // give it to tar so tar never opens the archive by path.
  let stagingDir = "";
  let partial: string;
  let stagingFd: number;
  try {
    stagingDir = mkdtempSync(`${output}.partial.${process.pid}.`);
    partial = join(stagingDir, "bundle.tar.gz");
    stagingFd = openSync(partial, "wx", 0o600);
  } catch (err) {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    error(
      `Failed to stage tarball for ${output}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return false;
  }
  let result;
  try {
    result = spawnSync("tar", ["czf", "-", "-C", dirname(collectDir), basename(collectDir)], {
      stdio: ["inherit", stagingFd, "inherit"],
      timeout: timeoutMs,
    });
  } finally {
    closeSync(stagingFd);
  }
  if (result.status !== 0 || result.signal) {
    const reason = result.signal
      ? `killed by signal ${result.signal}`
      : `exited with code ${result.status ?? "unknown"}`;
    error(`Failed to create tarball at ${output} (tar ${reason})`);
    try {
      rmSync(stagingDir, { recursive: true, force: true });
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
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    process.exitCode = 1;
    return false;
  }
  rmSync(stagingDir, { recursive: true, force: true });
  info(`Tarball written to ${output}`);
  warn(
    "Known secrets are auto-redacted, but please review for any remaining sensitive data before sharing.",
  );
  info("Attach this file to your GitHub issue.");
  return true;
}
