// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export interface OpenRegularFile {
  close(): void;
  readUtf8(): string;
  replaceUtf8(contents: string, mode: number): void;
}

export function openRegularFileNoFollow(
  target: string,
  options: { writable?: boolean } = {},
): OpenRegularFile {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("O_NOFOLLOW is unavailable");
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  const access = options.writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  const descriptor = fs.openSync(target, access | fs.constants.O_NOFOLLOW | nonblock);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fs.closeSync(descriptor);
  };
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("path is not a regular file");
    }
  } catch (error) {
    close();
    throw error;
  }
  return {
    close,
    readUtf8: () => {
      const size = fs.fstatSync(descriptor).size;
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
      const bytes = Buffer.from(contents, "utf-8");
      const written = fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
      if (written !== bytes.length) throw new Error("short write while replacing file");
      fs.ftruncateSync(descriptor, bytes.length);
      fs.fchmodSync(descriptor, mode);
    },
  };
}
