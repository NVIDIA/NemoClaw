// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type EntrySnapshot = fs.BigIntStats;
const FINGERPRINT_OPEN_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0);

function lstatEntry(absolutePath: string): EntrySnapshot {
  return fs.lstatSync(absolutePath, { bigint: true });
}

function fstatEntry(fd: number): EntrySnapshot {
  return fs.fstatSync(fd, { bigint: true });
}

function sameEntrySnapshot(left: EntrySnapshot, right: EntrySnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function requireStableEntry(
  relativePath: string,
  expected: EntrySnapshot,
  actual: EntrySnapshot,
): void {
  if (!sameEntrySnapshot(expected, actual)) {
    throw new Error(`build-context entry changed during fingerprint: ${relativePath || "."}`);
  }
}

function readPinnedRegularFile(
  absolutePath: string,
  relativePath: string,
): { contents: Buffer; stat: EntrySnapshot } | null {
  let fd: number;
  try {
    // Open before inspecting the path so the implementation consumes the same
    // inode it validates. O_NONBLOCK also prevents a file-to-FIFO swap from
    // hanging before fstat can reject the descriptor.
    fd = fs.openSync(absolutePath, FINGERPRINT_OPEN_FLAGS);
  } catch (openError) {
    // O_NOFOLLOW rejects symlinks where it is available, and some platforms do
    // not allow directories through openSync. Both remain path-fingerprinted;
    // a regular file that could not be pinned must fail closed.
    if (lstatEntry(absolutePath).isFile()) throw openError;
    return null;
  }

  try {
    const descriptorBefore = fstatEntry(fd);
    const pathBefore = lstatEntry(absolutePath);
    // Without O_NOFOLLOW, openSync can follow a symlink. Never consume that
    // descriptor as a regular build input; the caller fingerprints the link.
    if (pathBefore.isSymbolicLink() || !descriptorBefore.isFile()) return null;
    requireStableEntry(relativePath, pathBefore, descriptorBefore);
    const contents = fs.readFileSync(fd);
    requireStableEntry(relativePath, descriptorBefore, fstatEntry(fd));
    requireStableEntry(relativePath, pathBefore, lstatEntry(absolutePath));
    return { contents, stat: descriptorBefore };
  } finally {
    fs.closeSync(fd);
  }
}

/** Fingerprint every byte and entry type in a staged build context. */
export function fingerprintBuildContext(buildCtx: string): string {
  const hash = crypto.createHash("sha256");
  const contextRoot = path.resolve(buildCtx);
  const hardlinkOwners = new Map<string, string>();
  const updateEntry = (kind: string, relativePath: string, stat: EntrySnapshot): void => {
    // Docker COPY preserves the sticky, setgid, and setuid bits as well as
    // ordinary permissions, mtimes, and hardlink relationships. Include those
    // Docker-observable surfaces so a post-preflight metadata-only mutation
    // cannot reuse this fingerprint.
    hash.update(
      `${kind}\0${relativePath}\0${String(stat.mode & 0o7777n)}\0${String(stat.size)}\0${String(stat.mtimeNs)}\0`,
    );
    if (!stat.isDirectory()) {
      const inodeKey = `${String(stat.dev)}:${String(stat.ino)}`;
      const hardlinkOwner = hardlinkOwners.get(inodeKey) ?? relativePath;
      hardlinkOwners.set(inodeKey, hardlinkOwner);
      hash.update(`${String(stat.nlink)}\0${hardlinkOwner}\0`);
    }
  };
  const visit = (relativePath: string): void => {
    const absolutePath = path.join(contextRoot, relativePath);
    // The retained context must be a directory itself, not a symlink whose
    // target can change after preflight while the link text stays constant.
    const pinnedFile = relativePath ? readPinnedRegularFile(absolutePath, relativePath) : null;
    if (pinnedFile) {
      updateEntry("file", relativePath, pinnedFile.stat);
      hash.update(pinnedFile.contents);
    } else {
      const stat = lstatEntry(absolutePath);
      if (!relativePath && !stat.isDirectory()) {
        throw new Error("build-context root must be a real directory");
      }
      if (stat.isDirectory()) {
        updateEntry("dir", relativePath, stat);
        for (const name of fs.readdirSync(absolutePath).sort()) {
          visit(relativePath ? path.join(relativePath, name) : name);
        }
        requireStableEntry(relativePath, stat, lstatEntry(absolutePath));
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolutePath);
        requireStableEntry(relativePath, stat, lstatEntry(absolutePath));
        updateEntry("link", relativePath, stat);
        hash.update(target);
      } else {
        throw new Error(`unsupported build-context entry: ${relativePath || "."}`);
      }
    }
    hash.update("\0");
  };

  visit("");
  return hash.digest("hex");
}
