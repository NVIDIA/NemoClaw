// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
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
 * {@link assertDownloadedFile}, this check accepts file and directory
 * artifacts.
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

interface DirectoryHandle {
  fd: number;
  path: string;
  dev: number;
  ino: number;
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }) {
  return left.dev === right.dev && left.ino === right.ino;
}

function symlinkDestinationError(destination: string, candidate: string): Error {
  return new Error(
    `Refusing to publish the download to '${destination}': destination path '${candidate}' is a symbolic link.`,
  );
}

function openDirectoryNoFollow(directory: string, destination: string): DirectoryHandle {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
  let fd: number;
  try {
    // This pins an existing directory read-only; it does not create a
    // temporary file, even when the destination is below the OS temp root.
    // The mode is ignored without O_CREAT and remains private if creation is
    // introduced here later.
    fd = fs.openSync(directory, fs.constants.O_RDONLY | directoryFlag | noFollow, 0o600);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw symlinkDestinationError(destination, directory);
    }
    throw error;
  }
  try {
    const descriptorStat = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(directory);
    if (
      !descriptorStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      !sameIdentity(descriptorStat, pathStat)
    ) {
      throw new Error(
        `Refusing to publish the download to '${destination}': destination directory '${directory}' changed during validation.`,
      );
    }
    return { fd, path: directory, dev: descriptorStat.dev, ino: descriptorStat.ino };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertDirectoryIdentity(directory: DirectoryHandle, destination: string): void {
  const descriptorStat = fs.fstatSync(directory.fd);
  const pathStat = fs.lstatSync(directory.path);
  if (
    !descriptorStat.isDirectory() ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    !sameIdentity(directory, descriptorStat) ||
    !sameIdentity(directory, pathStat)
  ) {
    throw new Error(
      `Refusing to publish the download to '${destination}': destination directory '${directory.path}' changed during publication.`,
    );
  }
}

function ensureDirectoryNoFollow(directory: string, destination: string): DirectoryHandle {
  const resolved = path.resolve(directory);
  const missing: string[] = [];
  let existing = resolved;

  while (true) {
    try {
      const stat = fs.lstatSync(existing);
      if (stat.isSymbolicLink()) {
        throw symlinkDestinationError(destination, existing);
      }
      if (!stat.isDirectory()) {
        throw new Error(
          `Refusing to publish the download to '${destination}': destination path '${existing}' is not a directory.`,
        );
      }
      break;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw error;
      }
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  let current = fs.realpathSync(existing);
  let handle = openDirectoryNoFollow(current, destination);
  try {
    for (const component of missing) {
      assertDirectoryIdentity(handle, destination);
      const child = path.join(current, component);
      try {
        fs.mkdirSync(child);
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") {
          throw error;
        }
      }
      const childHandle = openDirectoryNoFollow(child, destination);
      assertDirectoryIdentity(handle, destination);
      fs.closeSync(handle.fd);
      handle = childHandle;
      current = child;
    }
    return handle;
  } catch (error) {
    fs.closeSync(handle.fd);
    throw error;
  }
}

function assertSafeDestinationEntry(destination: string): void {
  try {
    if (fs.lstatSync(destination).isSymbolicLink()) {
      throw symlinkDestinationError(destination, destination);
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function assertPrivateEntry(
  entryPath: string,
  expected: { dev: number; ino: number },
  destination: string,
): void {
  const stat = fs.lstatSync(entryPath);
  if (!sameIdentity(expected, stat)) {
    throw new Error(
      `Refusing to publish the download to '${destination}': private publication entry changed during validation.`,
    );
  }
}

const PINNED_DIRECTORY_RENAME_SCRIPT = `
const fs = require("node:fs");
const [
  temporaryName,
  destinationName,
  expectedDirectoryDev,
  expectedDirectoryIno,
  expectedTemporaryDev,
  expectedTemporaryIno,
] = process.argv.slice(1);
const sameIdentity = (stat, dev, ino) =>
  String(stat.dev) === dev && String(stat.ino) === ino;
const directoryStat = fs.statSync(".");
if (
  !directoryStat.isDirectory() ||
  !sameIdentity(directoryStat, expectedDirectoryDev, expectedDirectoryIno)
) {
  process.exit(70);
}
const temporaryStat = fs.lstatSync(temporaryName);
if (
  !temporaryStat.isFile() ||
  temporaryStat.nlink !== 1 ||
  !sameIdentity(temporaryStat, expectedTemporaryDev, expectedTemporaryIno)
) {
  process.exit(71);
}
try {
  if (fs.lstatSync(destinationName).isSymbolicLink()) {
    process.exit(72);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
fs.renameSync(temporaryName, destinationName);
`;

// The child establishes its current directory from the destination path, then
// confirms that directory still matches the parent's pinned descriptor before
// using relative names. Once established, the child's current directory stays
// anchored to that directory even if its host path is renamed or replaced.
function renameWithinPinnedDirectory(
  temporaryPath: string,
  destination: string,
  parent: DirectoryHandle,
  temporary: { dev: number; ino: number },
): void {
  const result = childProcess.spawnSync(
    process.execPath,
    [
      "-e",
      PINNED_DIRECTORY_RENAME_SCRIPT,
      path.basename(temporaryPath),
      path.basename(destination),
      String(parent.dev),
      String(parent.ino),
      String(temporary.dev),
      String(temporary.ino),
    ],
    {
      cwd: parent.path,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  if (result.error) {
    throw new Error(
      `Refusing to publish the download to '${destination}': could not enter the pinned destination directory.`,
      { cause: result.error },
    );
  }
  if (result.status === 70) {
    throw new Error(
      `Refusing to publish the download to '${destination}': destination directory '${parent.path}' changed before atomic publication.`,
    );
  }
  if (result.status === 71) {
    throw new Error(
      `Refusing to publish the download to '${destination}': private publication entry changed before atomic publication.`,
    );
  }
  if (result.status === 72) {
    throw symlinkDestinationError(destination, destination);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `publisher exited with status ${result.status}`;
    throw new Error(`Failed to publish the download to '${destination}': ${detail}`);
  }
}

function copyRegularFileToDescriptor(source: string, destinationFd: number): fs.Stats {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow | nonBlock);
  try {
    const stat = fs.fstatSync(sourceFd);
    const pathStat = fs.lstatSync(source);
    if (
      !stat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !sameIdentity(stat, pathStat)
    ) {
      throw new Error(`Refusing to publish non-regular staged artifact '${source}'.`);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let readPosition = 0;
    while (true) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, readPosition);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(destinationFd, buffer, written, bytesRead - written);
      }
      readPosition += bytesRead;
    }
    return stat;
  } finally {
    fs.closeSync(sourceFd);
  }
}

function replaceWithPrivateEntry(
  source: string,
  destination: string,
  parent: DirectoryHandle,
): void {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const temporaryPath = path.join(
    parent.path,
    `.${path.basename(destination)}.nemoclaw-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryFd: number | null = null;
  let temporaryExists = false;
  try {
    assertDirectoryIdentity(parent, destination);
    temporaryFd = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    temporaryExists = true;
    const temporaryStat = fs.fstatSync(temporaryFd);
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw new Error(`Refusing to publish through a non-private temporary file.`);
    }
    assertDirectoryIdentity(parent, destination);
    assertPrivateEntry(temporaryPath, temporaryStat, destination);
    const copiedStat = copyRegularFileToDescriptor(source, temporaryFd);
    fs.fchmodSync(temporaryFd, copiedStat.mode & 0o777);
    fs.fsyncSync(temporaryFd);
    fs.closeSync(temporaryFd);
    temporaryFd = null;
    assertPrivateEntry(temporaryPath, temporaryStat, destination);

    assertDirectoryIdentity(parent, destination);
    assertSafeDestinationEntry(destination);
    renameWithinPinnedDirectory(temporaryPath, destination, parent, temporaryStat);
    temporaryExists = false;
    assertDirectoryIdentity(parent, destination);
  } finally {
    if (temporaryFd !== null) fs.closeSync(temporaryFd);
    if (temporaryExists) {
      try {
        assertDirectoryIdentity(parent, destination);
        fs.unlinkSync(temporaryPath);
      } catch {
        // Leave an unreachable private entry rather than follow a changed path.
      }
    }
  }
}

function publishEntry(source: string, destination: string): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isDirectory()) {
    const destinationDirectory = ensureDirectoryNoFollow(destination, destination);
    try {
      for (const entry of fs.readdirSync(source)) {
        publishEntry(path.join(source, entry), path.join(destinationDirectory.path, entry));
      }
    } finally {
      fs.closeSync(destinationDirectory.fd);
    }
    return;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to publish symbolic link from staged artifact '${source}'.`);
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Refusing to publish unsupported staged artifact '${source}'.`);
  }

  const parent = ensureDirectoryNoFollow(path.dirname(destination), destination);
  try {
    replaceWithPrivateEntry(source, path.join(parent.path, path.basename(destination)), parent);
  } finally {
    fs.closeSync(parent.fd);
  }
}

/**
 * Publish a verified staging artifact without following destination symlinks.
 * Parent directories are pinned and revalidated, and file writes target a
 * private O_EXCL descriptor (plus O_NOFOLLOW where available) before an atomic
 * rename publishes the entry.
 */
export function publishDownloadArtifact(
  stagedArtifact: string,
  expectedArtifact: string,
  sourceKind: SandboxSourceKind,
): void {
  const stagedStat = fs.lstatSync(stagedArtifact);
  if (sourceKind === "dir" && !stagedStat.isDirectory()) {
    throw new Error(`Refusing to publish non-directory staged artifact '${stagedArtifact}'.`);
  }
  if (sourceKind === "file" && stagedStat.isDirectory()) {
    throw new Error(`Refusing to publish directory staged artifact '${stagedArtifact}' as a file.`);
  }
  publishEntry(stagedArtifact, expectedArtifact);
}
