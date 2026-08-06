// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const MAX_CREDENTIAL_BYTES = 4096;
const MIN_CREDENTIAL_BYTES = 32;

function validatePrivateRegularFile(stat: fs.Stats, filePath: string, label: string): void {
  if (!stat.isFile()) throw new Error(`${label} path is not a regular file: ${filePath}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} file must not be accessible by group or others: ${filePath}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} file is not owned by the current user: ${filePath}`);
  }
  if (stat.size < MIN_CREDENTIAL_BYTES || stat.size > MAX_CREDENTIAL_BYTES + 1) {
    throw new Error(`${label} file has an invalid size: ${filePath}`);
  }
}

function validateBearer(value: string, label: string): void {
  const bytes = Buffer.byteLength(value);
  if (
    bytes < MIN_CREDENTIAL_BYTES ||
    bytes > MAX_CREDENTIAL_BYTES ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new Error(`${label} is malformed.`);
  }
}

/** Read one owner-only bearer without following the final path component. */
export function readPrivateBearerFile(filePath: string, label: string): string {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} file path must be absolute.`);
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform.");
  }

  let descriptor: number | undefined;
  try {
    try {
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") {
        throw new Error(`Refusing to read a symbolic-link ${label} file: ${filePath}`);
      }
      throw error;
    }

    validatePrivateRegularFile(fs.fstatSync(descriptor), filePath, label);
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 2);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CREDENTIAL_BYTES + 1) {
      throw new Error(`${label} file has an invalid size: ${filePath}`);
    }
    const contents = buffer.subarray(0, bytesRead).toString("utf8");
    const value = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
    validateBearer(value, label);
    return value;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
