// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface CreateTarballOptions {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  /** Timeout for the underlying `tar` invocation. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/**
 * Archive `collectDir` through an exclusively created descriptor inside an
 * owner-only sibling directory. Atomically publish the archive only after
 * success, preserving existing output on failure. Set `process.exitCode` on
 * failure so callers do not have to remember.
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
  let partial = "";
  let descriptor: number | undefined;
  let ownsPartial = false;
  try {
    stagingDir = mkdtempSync(`${output}.partial.${process.pid}.`);
    partial = join(stagingDir, "bundle.tar.gz");
    descriptor = openSync(
      partial,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    ownsPartial = true;
    const result = spawnSync("tar", ["czf", "-", "-C", dirname(collectDir), basename(collectDir)], {
      stdio: ["ignore", descriptor, "inherit"],
      timeout: timeoutMs,
    });
    closeSync(descriptor);
    descriptor = undefined;
    if (result.status !== 0 || result.signal || result.error) {
      const reason = result.error
        ? result.error.message
        : result.signal
          ? `killed by signal ${result.signal}`
          : `exited with code ${result.status ?? "unknown"}`;
      error(`Failed to create tarball at ${output} (tar ${reason})`);
      process.exitCode = 1;
      return false;
    }
    try {
      renameSync(partial, output);
    } catch (err) {
      error(
        `Failed to move tarball into place at ${output}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
      return false;
    }
    ownsPartial = false;
  } catch (err) {
    error(
      `Failed to create tarball at ${output}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best-effort close after an archive failure */
      }
    }
    if (ownsPartial) {
      try {
        rmSync(partial, { force: true });
      } catch {
        /* best-effort cleanup of the owned partial tarball */
      }
    }
    if (stagingDir) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup of the owner-only staging directory */
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
