// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export interface DownloadOutcome {
  status: number | null;
}

export interface VerifyDownloadedFileOptions {
  /** Sandbox-side source label used in error messages (e.g. the remote path). */
  remoteLabel: string;
  /** Sandbox name used in error messages. */
  sandboxName: string;
  /**
   * Require the artifact to be non-empty. Set for a bundle that is never
   * legitimately empty (a gzip tarball of at least one file); leave off for
   * individual session files and for the hermes export, whose size we do not
   * want to constrain (a zero-session hermes export can be legitimately empty).
   */
  requireNonEmpty?: boolean;
}

/**
 * Confirm that an `openshell sandbox download` of a single file both reported
 * success AND actually produced the artifact on the host.
 *
 * The exit status alone cannot be trusted: `openshell sandbox download` has a
 * process-exit race that can report success (exit 0) even when the transfer
 * was rejected or failed and no file was written (NVIDIA/OpenShell; NemoClaw
 * #7367). Trusting exit 0 alone would let a rejected or partial download be
 * recorded as a valid session bundle, so re-check the outcome against the file
 * system before treating the download as complete.
 *
 * `hostPath` must be a path that did not exist before the download — a fresh
 * per-export staging path, published to its real destination only after this
 * check passes. The check can only establish that SOMETHING exists at
 * `hostPath`; run against a reused destination it would accept a stale
 * artifact left by an earlier export and mask the exit-0/no-write race it
 * exists to catch.
 *
 * @throws if the download reported a non-zero status, wrote no file, wrote a
 * non-regular file, or (when `requireNonEmpty`) wrote an empty file.
 */
export function assertDownloadedFile(
  download: DownloadOutcome,
  hostPath: string,
  options: VerifyDownloadedFileOptions,
): void {
  const { remoteLabel, sandboxName, requireNonEmpty = false } = options;
  const prefix = `Failed to download '${remoteLabel}' from sandbox '${sandboxName}'`;

  if (download.status !== 0) {
    throw new Error(`${prefix} (exit ${download.status}).`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(hostPath);
  } catch {
    throw new Error(
      `${prefix}: openshell reported success (exit 0) but no file was written to '${hostPath}'.`,
    );
  }

  if (!stat.isFile()) {
    throw new Error(
      `${prefix}: openshell reported success (exit 0) but '${hostPath}' is not a regular file.`,
    );
  }

  if (requireNonEmpty && stat.size === 0) {
    throw new Error(
      `${prefix}: openshell reported success (exit 0) but wrote an empty file to '${hostPath}'.`,
    );
  }
}
