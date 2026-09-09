// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export interface OpenRegularFile {
  close(): void;
  readBytes(maxBytes: number): Buffer;
  readUtf8(maxBytes?: number): string;
  replaceUtf8(contents: string, mode: number): void;
  stat(): fs.Stats;
}

export function openRegularFileNoFollow(
  target: string,
  options: { create?: boolean; mode?: number; writable?: boolean } = {},
): OpenRegularFile {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("O_NOFOLLOW is unavailable");
  }
  if (options.create && !options.writable) {
    throw new Error("creating a regular file requires writable access");
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  const access = options.writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  const create = options.create ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0;
  const descriptor = fs.openSync(
    target,
    access | create | fs.constants.O_NOFOLLOW | nonblock,
    options.mode ?? 0o600,
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fs.closeSync(descriptor);
  };
  const assertPathIdentity = (): fs.Stats => {
    const descriptorStats = fs.fstatSync(descriptor);
    const pathStats = fs.lstatSync(target);
    if (
      !descriptorStats.isFile() ||
      descriptorStats.nlink !== 1 ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      pathStats.nlink !== 1 ||
      descriptorStats.dev !== pathStats.dev ||
      descriptorStats.ino !== pathStats.ino
    ) {
      throw new Error(`regular file changed during validation: ${target}`);
    }
    return descriptorStats;
  };
  try {
    const descriptorStats = fs.fstatSync(descriptor);
    if (!descriptorStats.isFile()) {
      throw new Error("path is not a regular file");
    }
    if (descriptorStats.nlink !== 1) {
      throw new Error(`regular file changed during validation: ${target}`);
    }
    assertPathIdentity();
  } catch (error) {
    close();
    throw error;
  }
  const readBytes = (maxBytes: number): Buffer => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError(`regular file read limit must be a non-negative integer: ${target}`);
    }
    const beforeRead = assertPathIdentity();
    if (beforeRead.size > maxBytes) {
      throw new RangeError(`regular file exceeds the ${maxBytes}-byte read limit: ${target}`);
    }
    const bytes = Buffer.alloc(beforeRead.size);
    let offset = 0;
    while (offset < beforeRead.size) {
      const read = fs.readSync(descriptor, bytes, offset, beforeRead.size - offset, offset);
      if (read === 0) throw new Error(`short read from regular file: ${target}`);
      offset += read;
    }
    const afterRead = assertPathIdentity();
    if (
      beforeRead.dev !== afterRead.dev ||
      beforeRead.ino !== afterRead.ino ||
      beforeRead.nlink !== afterRead.nlink ||
      beforeRead.mode !== afterRead.mode ||
      beforeRead.size !== afterRead.size ||
      beforeRead.mtimeMs !== afterRead.mtimeMs ||
      beforeRead.ctimeMs !== afterRead.ctimeMs
    ) {
      throw new Error(`regular file changed while reading: ${target}`);
    }
    return bytes;
  };
  return {
    close,
    readBytes,
    readUtf8: (maxBytes) => {
      const size = fs.fstatSync(descriptor).size;
      if (maxBytes !== undefined && size > maxBytes) {
        throw new RangeError(`regular file exceeds the ${maxBytes}-byte read limit: ${target}`);
      }
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = fs.readSync(descriptor, bytes, offset, size - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      return bytes.subarray(0, offset).toString("utf-8");
    },
    replaceUtf8: (contents, mode) => {
      assertPathIdentity();
      const bytes = Buffer.from(contents, "utf-8");
      const written = fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
      if (written !== bytes.length) throw new Error("short write while replacing file");
      fs.ftruncateSync(descriptor, bytes.length);
      fs.fchmodSync(descriptor, mode);
      assertPathIdentity();
    },
    stat: assertPathIdentity,
  };
}
