// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BoundedRegularFileOptions {
  maxBytes: number;
  minBytes?: number;
  label: string;
}

export interface BoundedExecutableSnapshotOptions extends BoundedRegularFileOptions {
  expectedDigest?: string;
  temporaryDirectoryPrefix: string;
}

export interface BoundedExecutableSnapshot {
  executable: string;
  executableDigest: string;
  homeDirectory: string;
  temporaryDirectory: string;
  cleanup: () => void;
}

const TRUSTED_EXECUTABLE_PATH = "/usr/bin:/bin";

/** Build a small, deterministic process environment inside the private snapshot directory. */
export function isolatedExecutableEnvironment(
  snapshot: BoundedExecutableSnapshot,
): NodeJS.ProcessEnv {
  return {
    HOME: snapshot.homeDirectory,
    LANG: "C",
    LC_ALL: "C",
    PATH: TRUSTED_EXECUTABLE_PATH,
    TEMP: snapshot.temporaryDirectory,
    TMP: snapshot.temporaryDirectory,
    TMPDIR: snapshot.temporaryDirectory,
  };
}

interface StableRead {
  contents: Buffer;
  mode: bigint;
}

function validBounds(options: BoundedRegularFileOptions): { minBytes: number; maxBytes: number } {
  const minBytes = options.minBytes ?? 0;
  if (
    !Number.isSafeInteger(minBytes) ||
    !Number.isSafeInteger(options.maxBytes) ||
    minBytes < 0 ||
    options.maxBytes < minBytes
  ) {
    throw new Error(`${options.label} has invalid byte bounds`);
  }
  return { minBytes, maxBytes: options.maxBytes };
}

function hasStableIdentity(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.rdev === after.rdev &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.birthtimeNs === after.birthtimeNs
  );
}

function readStableDescriptor(descriptor: number, options: BoundedRegularFileOptions): StableRead {
  const { minBytes, maxBytes } = validBounds(options);
  const before = fs.fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.size < BigInt(minBytes) || before.size > BigInt(maxBytes)) {
    throw new Error(
      `${options.label} must be a regular file from ${String(minBytes)} through ${String(maxBytes)} bytes`,
    );
  }

  const declaredSize = Number(before.size);
  const contents = Buffer.alloc(declaredSize + 1);
  let offset = 0;
  while (offset < contents.length) {
    const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }

  const after = fs.fstatSync(descriptor, { bigint: true });
  if (offset !== declaredSize || !after.isFile() || !hasStableIdentity(before, after)) {
    throw new Error(`${options.label} changed during bounded validation`);
  }
  return { contents: contents.subarray(0, offset), mode: before.mode };
}

function readBoundedFile(filePath: string, options: BoundedRegularFileOptions): StableRead {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return readStableDescriptor(descriptor, options);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isWithinTrustedExecutableRoot(filePath: string): boolean {
  return ["/bin", "/usr/bin", "/usr/local/bin"].some(
    (root) => filePath === root || filePath.startsWith(`${root}${path.sep}`),
  );
}

function validateTrustedInterpreterPath(interpreter: string, label: string): void {
  let resolved: string;
  let stat: fs.Stats;
  try {
    resolved = fs.realpathSync(interpreter);
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`${label} uses an unavailable interpreter`);
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} uses an untrusted interpreter`);
  }

  // Production CUA runs on Linux. Its script interpreter must be rooted in the
  // immutable host toolchain and must not be replaceable by the invoking user.
  // Non-Linux contributor tests may use the exact Node binary already executing
  // this process; no other user-owned interpreter is accepted.
  if (process.platform === "linux") {
    if (stat.uid !== 0 || !isWithinTrustedExecutableRoot(resolved)) {
      throw new Error(`${label} uses an untrusted interpreter`);
    }
  } else if (
    resolved !== fs.realpathSync(process.execPath) &&
    !isWithinTrustedExecutableRoot(resolved)
  ) {
    throw new Error(`${label} uses an untrusted interpreter`);
  }
}

function validateDirectInterpreter(contents: Buffer, label: string): void {
  if (contents.length < 2 || contents[0] !== 0x23 || contents[1] !== 0x21) return;
  const lineEnd = contents.indexOf(0x0a, 2);
  const shebang = contents.subarray(2, lineEnd === -1 ? contents.length : lineEnd).toString("utf8");
  if (/[^\x20-\x7e\t]/u.test(shebang)) {
    throw new Error(`${label} uses an unsupported interpreter`);
  }
  const words = shebang.trim().split(/[\t ]+/u);
  const interpreter = words[0] ?? "";
  if (words.length !== 1 || !path.isAbsolute(interpreter) || path.basename(interpreter) === "env") {
    throw new Error(`${label} uses an unsupported interpreter`);
  }
  validateTrustedInterpreterPath(interpreter, label);
}

/** Read one regular, non-symlink file without allocating beyond its declared bound. */
export function readBoundedRegularFile(
  filePath: string,
  options: BoundedRegularFileOptions,
): Buffer {
  return readBoundedFile(filePath, options).contents;
}

/**
 * Copy one executable into a private directory and bind the copy to its source bytes.
 *
 * The source is opened without following links and its identity, size, mode, and
 * modification timestamps must remain stable for the complete read. Script
 * interpreters must be direct absolute paths; `/usr/bin/env` would reintroduce
 * caller-controlled executable resolution after the byte digest is checked.
 */
export function snapshotBoundedExecutable(
  filePath: string,
  options: BoundedExecutableSnapshotOptions,
): BoundedExecutableSnapshot {
  const source = readBoundedFile(filePath, options);
  if ((source.mode & 0o111n) === 0n) {
    throw new Error(`${options.label} must be executable`);
  }
  validateDirectInterpreter(source.contents, options.label);

  const executableDigest = `sha256:${crypto.createHash("sha256").update(source.contents).digest("hex")}`;
  if (options.expectedDigest !== undefined && executableDigest !== options.expectedDigest) {
    throw new Error(`${options.label} does not match its expected digest`);
  }

  let directory: string | undefined;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), options.temporaryDirectoryPrefix));
    fs.chmodSync(directory, 0o700);
    const homeDirectory = path.join(directory, "home");
    const temporaryDirectory = path.join(directory, "tmp");
    fs.mkdirSync(homeDirectory, { mode: 0o700 });
    fs.mkdirSync(temporaryDirectory, { mode: 0o700 });

    const sourceExtension = path.extname(filePath);
    const executableExtension = [".cjs", ".js", ".mjs"].includes(sourceExtension)
      ? sourceExtension
      : "";
    const executable = path.join(directory, `executable${executableExtension}`);
    const descriptor = fs.openSync(
      executable,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o500,
    );
    try {
      fs.fchmodSync(descriptor, 0o500);
      let offset = 0;
      while (offset < source.contents.length) {
        offset += fs.writeSync(
          descriptor,
          source.contents,
          offset,
          source.contents.length - offset,
        );
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    const snapshotDirectory = directory;
    return {
      executable,
      executableDigest,
      homeDirectory,
      temporaryDirectory,
      cleanup: () => fs.rmSync(snapshotDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
