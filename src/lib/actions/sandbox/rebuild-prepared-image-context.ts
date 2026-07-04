// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PreparedSandboxBuildContext } from "../../onboard/build-context-stage";

export type FingerprintedPreparedBuildContext = PreparedSandboxBuildContext & {
  contextFingerprint: string;
  verifyBuildCtx(): boolean;
};

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
  const updateEntry = (kind: string, relativePath: string, stat: EntrySnapshot): void => {
    hash.update(`${kind}\0${relativePath}\0${String(stat.mode & 0o777n)}\0${String(stat.size)}\0`);
  };
  const visit = (relativePath: string): void => {
    const absolutePath = path.join(buildCtx, relativePath);
    const pinnedFile = readPinnedRegularFile(absolutePath, relativePath);
    if (pinnedFile) {
      updateEntry("file", relativePath, pinnedFile.stat);
      hash.update(pinnedFile.contents);
    } else {
      const stat = lstatEntry(absolutePath);
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

/** Keep temporary rebuild inputs alive until the transaction releases them. */
export function createIdempotentBuildContextCleanup(cleanup: () => boolean): () => boolean {
  let cleaned = false;
  const dispose = () => {
    if (cleaned) return true;
    const succeeded = cleanup();
    if (succeeded) {
      cleaned = true;
      process.removeListener("exit", dispose);
    }
    return succeeded;
  };
  process.on("exit", dispose);
  return dispose;
}

/** Confirm that a retained private context still matches the prebuilt bytes. */
export function verifyPreparedBuildContext(prepared: FingerprintedPreparedBuildContext): boolean {
  try {
    return fingerprintBuildContext(prepared.buildCtx) === prepared.contextFingerprint;
  } catch {
    return false;
  }
}

/** Bind an expected fingerprint to a context for final one-shot verification. */
export function createBuildContextVerifier(
  buildCtx: string,
  contextFingerprint: string,
): () => boolean {
  return () => {
    try {
      return fingerprintBuildContext(buildCtx) === contextFingerprint;
    } catch {
      return false;
    }
  };
}

/** Dispose retained build inputs after onboarding consumes them or rebuild aborts. */
export function disposePreparedBuildContext(prepared: FingerprintedPreparedBuildContext): boolean {
  return prepared.cleanupBuildCtx();
}
