// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

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

export type SandboxSourceKind = "file" | "dir";

/**
 * Resolve where a successful `openshell sandbox download` lands on the host,
 * following openshell's cp-style semantics, so the caller can confirm the
 * artifact actually appeared (openshell can exit 0 without writing — #7367).
 *
 * - A directory source is extracted into `hostDest` (openshell creates it when
 *   absent), so `hostDest` itself is the artifact to confirm.
 * - A file source lands at `hostDest/<basename>` when `hostDest` is a directory
 *   target (an existing directory or a trailing-separator path); otherwise
 *   `hostDest` is the exact file path.
 *
 * Called before the download so `hostDest`'s directory-ness reflects the same
 * pre-download state openshell itself branches on.
 */
export function resolveDownloadArtifactPath(
  sandboxPath: string,
  hostDest: string,
  sourceKind: SandboxSourceKind,
): string {
  const existingDirectory = fs.existsSync(hostDest) && fs.statSync(hostDest).isDirectory();
  const directoryTarget =
    hostDest.endsWith(path.sep) || hostDest.endsWith("/") || existingDirectory;
  const resolvedDirectory = existingDirectory ? fs.realpathSync(hostDest) : hostDest;
  if (sourceKind === "dir") {
    return resolvedDirectory;
  }
  return directoryTarget ? path.join(resolvedDirectory, path.basename(sandboxPath)) : hostDest;
}

/**
 * Confirm a reported-success download produced an artifact at `hostPath`
 * (a file or a directory — the download command supports both). Unlike
 * {@link assertDownloadedFile}, this does not require a regular file, so it is
 * safe for directory downloads.
 *
 * `hostPath` must be a fresh staging path that did not exist before the
 * download. A pre-existing path could hold a stale artifact from an earlier
 * transfer and make this check vacuous.
 *
 * @throws if nothing exists at `hostPath` — i.e. openshell exited 0 without
 * writing, the #7367 race.
 */
export function assertDownloadArtifactExists(
  hostPath: string,
  { remoteLabel, sandboxName }: { remoteLabel: string; sandboxName: string },
): void {
  if (!fs.existsSync(hostPath)) {
    throw new Error(
      `Failed to download '${remoteLabel}' from sandbox '${sandboxName}': openshell reported success (exit 0) but nothing was written to '${hostPath}'.`,
    );
  }
}

function assertNoSymlinkInDestinationPath(destinationRoot: string, destination: string): void {
  const root = path.resolve(destinationRoot);
  let candidate = path.resolve(destination);
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to publish the download outside '${destinationRoot}'.`);
  }
  while (true) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error(
          `Refusing to publish the download to '${destination}': destination path '${candidate}' is a symbolic link.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (candidate === root) {
      return;
    }
    const parent = path.dirname(candidate);
    candidate = parent;
  }
}

/**
 * Copy a verified staging artifact to its caller-selected destination without
 * following an existing destination symlink.
 */
export function publishDownloadArtifact(
  stagedArtifact: string,
  expectedArtifact: string,
  sourceKind: SandboxSourceKind,
): void {
  fs.cpSync(stagedArtifact, expectedArtifact, {
    recursive: sourceKind === "dir",
    force: true,
    filter: (_source, destination) => {
      assertNoSymlinkInDestinationPath(expectedArtifact, destination);
      return true;
    },
  });
}
