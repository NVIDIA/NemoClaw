// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

const HASH_BUFFER_BYTES = 64 * 1024;

export interface ServiceFileStat {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  mode: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  size: bigint;
  uid: bigint;
}

export interface ServiceFileIdentityOptions {
  closeSync?: (fileDescriptor: number) => void;
  contentsLimit?: number;
  expectedUid: number;
  filePath: string;
  fstatSync?: (fileDescriptor: number) => ServiceFileStat;
  hashContents?: boolean;
  lstatSync?: (filePath: string) => ServiceFileStat;
  openSync?: (filePath: string, flags: number) => number;
  readSync?: (
    fileDescriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ) => number;
  requiredModeBits?: number;
}

export interface ServiceFileIdentity {
  changedTimeNanoseconds: string;
  contentSha256?: string;
  device: string;
  inode: string;
  linkCount: string;
  mode: number;
  modifiedTimeNanoseconds: string;
  owner: number;
  size: string;
}

export interface ServiceFileInspection {
  contents?: Buffer;
  identity: ServiceFileIdentity;
}

function defaultFstatSync(fileDescriptor: number): ServiceFileStat {
  return fs.fstatSync(fileDescriptor, { bigint: true });
}

function defaultLstatSync(filePath: string): ServiceFileStat {
  return fs.lstatSync(filePath, { bigint: true });
}

function validOptions(options: ServiceFileIdentityOptions): boolean {
  return (
    Number.isSafeInteger(options.expectedUid) &&
    options.expectedUid >= 0 &&
    (options.contentsLimit === undefined ||
      (Number.isSafeInteger(options.contentsLimit) && options.contentsLimit >= 0)) &&
    (options.requiredModeBits === undefined ||
      (Number.isSafeInteger(options.requiredModeBits) &&
        options.requiredModeBits >= 0 &&
        options.requiredModeBits <= 0o7777))
  );
}

function validStat(stat: ServiceFileStat, expectedUid: number): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === BigInt(expectedUid) &&
    stat.dev >= 0n &&
    stat.ino >= 0n &&
    stat.nlink >= 1n &&
    stat.size >= 0n &&
    stat.mode >= 0n &&
    stat.mtimeNs >= 0n &&
    stat.ctimeNs >= 0n
  );
}

function sameStat(first: ServiceFileStat, second: ServiceFileStat): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.uid === second.uid &&
    first.mode === second.mode &&
    first.nlink === second.nlink &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

function inspectContents(
  fileDescriptor: number,
  size: bigint,
  options: ServiceFileIdentityOptions,
): { contents?: Buffer; sha256?: string } | null {
  const includeContents = options.contentsLimit !== undefined;
  const includeHash = options.hashContents === true || includeContents;
  if (!includeHash) return {};
  if (includeContents && size > BigInt(options.contentsLimit as number)) return null;

  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let remaining = size;
  while (remaining > 0n) {
    const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
    const count = (options.readSync ?? fs.readSync)(fileDescriptor, buffer, 0, length, null);
    if (!Number.isSafeInteger(count) || count <= 0 || count > length) return null;
    const bytes = buffer.subarray(0, count);
    hash.update(bytes);
    if (includeContents) chunks.push(Buffer.from(bytes));
    remaining -= BigInt(count);
  }
  return {
    ...(includeContents ? { contents: Buffer.concat(chunks) } : {}),
    sha256: hash.digest("hex"),
  };
}

function serviceFileIdentity(
  stat: ServiceFileStat,
  contentSha256: string | undefined,
): ServiceFileIdentity {
  return {
    changedTimeNanoseconds: String(stat.ctimeNs),
    ...(contentSha256 === undefined ? {} : { contentSha256 }),
    device: String(stat.dev),
    inode: String(stat.ino),
    linkCount: String(stat.nlink),
    mode: Number(stat.mode & 0o7777n),
    modifiedTimeNanoseconds: String(stat.mtimeNs),
    owner: Number(stat.uid),
    size: String(stat.size),
  };
}

/** Inspect a service file without returning its path, bytes, or read errors on failure. */
export function inspectServiceFileIdentity(
  options: ServiceFileIdentityOptions,
): ServiceFileInspection | null {
  if (!validOptions(options)) return null;
  if (typeof fs.constants.O_NOFOLLOW !== "number" || typeof fs.constants.O_NONBLOCK !== "number") {
    return null;
  }
  let fileDescriptor: number;
  try {
    fileDescriptor = (options.openSync ?? fs.openSync)(
      options.filePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }

  let result: ServiceFileInspection | null = null;
  try {
    const fstatSync = options.fstatSync ?? defaultFstatSync;
    const before = fstatSync(fileDescriptor);
    const requiredModeBits = BigInt(options.requiredModeBits ?? 0);
    if (
      validStat(before, options.expectedUid) &&
      (requiredModeBits === 0n || before.size > 0n) &&
      (before.mode & requiredModeBits) === requiredModeBits
    ) {
      const content = inspectContents(fileDescriptor, before.size, options);
      const after = content ? fstatSync(fileDescriptor) : null;
      const named = after ? (options.lstatSync ?? defaultLstatSync)(options.filePath) : null;
      if (
        content &&
        after &&
        named &&
        validStat(after, options.expectedUid) &&
        validStat(named, options.expectedUid) &&
        sameStat(before, after) &&
        sameStat(after, named)
      ) {
        result = {
          ...(content.contents === undefined ? {} : { contents: content.contents }),
          identity: serviceFileIdentity(after, content.sha256),
        };
      }
    }
  } catch {
    result = null;
  }
  try {
    (options.closeSync ?? fs.closeSync)(fileDescriptor);
  } catch {
    result = null;
  }
  return result;
}

/** Compare every recorded service file attribute across lifecycle checks. */
export function sameServiceFileIdentity(
  first: ServiceFileIdentity,
  second: ServiceFileIdentity,
): boolean {
  return (
    first.device === second.device &&
    first.inode === second.inode &&
    first.owner === second.owner &&
    first.mode === second.mode &&
    first.linkCount === second.linkCount &&
    first.size === second.size &&
    first.modifiedTimeNanoseconds === second.modifiedTimeNanoseconds &&
    first.changedTimeNanoseconds === second.changedTimeNanoseconds &&
    first.contentSha256 === second.contentSha256
  );
}
