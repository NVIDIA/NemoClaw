// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Create a temp file inside a directory with a cryptographically random name.
 * Uses fs.mkdtempSync (OS-level mkdtemp) to avoid predictable filenames that
 * could be exploited via symlink attacks on shared /tmp.
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/1093
 */
function validateTempPrefix(prefix: string): string {
  if (
    prefix.length === 0 ||
    prefix !== path.basename(prefix) ||
    prefix.includes(path.posix.sep) ||
    prefix.includes(path.win32.sep)
  ) {
    throw new Error(`Invalid temp file prefix: ${prefix}`);
  }
  return prefix;
}

export function secureTempFile(prefix: string, ext = ""): string {
  const safePrefix = validateTempPrefix(prefix);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${safePrefix}-`));
  return path.join(dir, `${safePrefix}${ext}`);
}

/**
 * Safely remove a mkdtemp-created directory. Guards against accidentally
 * deleting the system temp root if a caller passes os.tmpdir() itself.
 */
export function cleanupTempDir(filePath: string, expectedPrefix: string): void {
  const safePrefix = validateTempPrefix(expectedPrefix);
  const tempRoot = path.resolve(os.tmpdir());
  const parentDir = path.resolve(path.dirname(filePath));
  const relativeParent = path.relative(tempRoot, parentDir);
  const isInsideTempRoot =
    relativeParent !== "" && !relativeParent.startsWith("..") && !path.isAbsolute(relativeParent);
  if (isInsideTempRoot && path.basename(parentDir).startsWith(`${safePrefix}-`)) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
}

type ExactTempFileAuthority = {
  readonly bytesSha256: string;
  readonly fileDev: bigint;
  readonly fileIno: bigint;
  readonly parentDev: bigint;
  readonly parentIno: bigint;
};

function readExactTempFileAuthority(filePath: string): ExactTempFileAuthority {
  const tempRoot = path.resolve(os.tmpdir());
  const parentDir = path.resolve(path.dirname(filePath));
  const relativeParent = path.relative(tempRoot, parentDir);
  if (relativeParent === "" || relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new Error("Exact temporary file authority is outside its task-owned directory");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Current-user temporary file authority is unavailable");
  const parent = fs.lstatSync(parentDir, { bigint: true });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== BigInt(uid) ||
    (parent.mode & 0o777n) !== 0o700n ||
    fs.readdirSync(parentDir).some((entry) => entry !== path.basename(filePath))
  ) {
    throw new Error(
      "Exact temporary file directory must be a non-symlink directory with mode 0700, current-user ownership when available, and only the expected file",
    );
  }
  const named = fs.lstatSync(filePath, { bigint: true });
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(uid) ||
      (before.mode & 0o777n) !== 0o600n ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error(
        "Exact temporary file must be a regular single-link file with mode 0600 and current-user ownership when available",
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalParent = fs.lstatSync(parentDir, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      parent.dev !== finalParent.dev ||
      parent.ino !== finalParent.ino ||
      parent.uid !== finalParent.uid ||
      parent.mode !== finalParent.mode
    ) {
      throw new Error("Exact temporary file authority changed while reading");
    }
    return {
      bytesSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      fileDev: before.dev,
      fileIno: before.ino,
      parentDev: parent.dev,
      parentIno: parent.ino,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function captureExactTempFileAuthority(
  filePath: string,
  expectedPrefix: string,
): ExactTempFileAuthority {
  const safePrefix = validateTempPrefix(expectedPrefix);
  const parentDir = path.resolve(path.dirname(filePath));
  if (
    !path.basename(parentDir).startsWith(`${safePrefix}-`) ||
    path.basename(filePath) !== `${safePrefix}${path.extname(filePath)}`
  ) {
    throw new Error("Exact temporary file authority is outside its task-owned directory");
  }
  return readExactTempFileAuthority(filePath);
}

/** Detach and remove only one exact task-created policy file generation. */
export function createExactTempFileCleanup(
  filePath: string,
  expectedPrefix: string,
): () => boolean {
  const authority = captureExactTempFileAuthority(filePath, expectedPrefix);
  const parentDir = path.resolve(path.dirname(filePath));
  const fileName = path.basename(filePath);
  let completed = false;
  return () => {
    if (completed) return true;
    try {
      const current = captureExactTempFileAuthority(filePath, expectedPrefix);
      if (
        current.parentDev !== authority.parentDev ||
        current.parentIno !== authority.parentIno ||
        current.fileDev !== authority.fileDev ||
        current.fileIno !== authority.fileIno ||
        current.bytesSha256 !== authority.bytesSha256
      ) {
        return false;
      }
      const quarantine = fs.mkdtempSync(
        path.join(path.resolve(os.tmpdir()), `${validateTempPrefix(expectedPrefix)}-retired-`),
      );
      fs.chmodSync(quarantine, 0o700);
      const detachedParent = path.join(quarantine, "source");
      let detached = false;
      const restore = (): boolean => {
        if (!detached) return true;
        if (fs.existsSync(parentDir)) return false;
        try {
          fs.renameSync(detachedParent, parentDir);
          detached = false;
          fs.rmdirSync(quarantine);
          return true;
        } catch {
          return false;
        }
      };
      try {
        fs.renameSync(parentDir, detachedParent);
        detached = true;
        const detachedFile = path.join(detachedParent, fileName);
        const detachedAuthority = readExactTempFileAuthority(detachedFile);
        const finalNamed = fs.lstatSync(detachedFile, { bigint: true });
        if (
          detachedAuthority.parentDev !== authority.parentDev ||
          detachedAuthority.parentIno !== authority.parentIno ||
          detachedAuthority.fileDev !== authority.fileDev ||
          detachedAuthority.fileIno !== authority.fileIno ||
          detachedAuthority.bytesSha256 !== authority.bytesSha256 ||
          finalNamed.dev !== authority.fileDev ||
          finalNamed.ino !== authority.fileIno
        ) {
          restore();
          return false;
        }
        fs.unlinkSync(detachedFile);
        fs.rmdirSync(detachedParent);
        detached = false;
        fs.rmdirSync(quarantine);
        completed = true;
        return true;
      } catch {
        restore();
        return false;
      }
    } catch {
      return false;
    }
  };
}
