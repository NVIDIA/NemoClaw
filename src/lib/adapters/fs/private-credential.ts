// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export const MAX_PRIVATE_CREDENTIAL_BYTES = 4096;

function validateCredential(value: string, label: string): void {
  if (
    Buffer.byteLength(value) < 32 ||
    Buffer.byteLength(value) > MAX_PRIVATE_CREDENTIAL_BYTES ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new Error(`${label} is malformed.`);
  }
}

function validateCredentialDirectoryChain(directory: string, label: string): void {
  let current = directory;
  while (current !== path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} directory must not be a symlink.`);
    }
    if (!stat.isDirectory()) throw new Error(`${label} parent path is not a directory.`);
    if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) break;
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`${label} directory must not be writable by group or others.`);
    }
    current = path.dirname(current);
  }
}

/** Read one owner-only credential without following its final path component. */
export function readPrivateCredentialFile(filePath: string, label: string): string {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} file path must be absolute.`);
  validateCredentialDirectoryChain(path.dirname(filePath), label);
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error(
      "This platform does not support opening credential files without following symbolic links.",
    );
  }
  let descriptor: number | undefined;
  try {
    try {
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`${label} file must not be a symbolic link.`);
      }
      throw error;
    }
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} path is not a regular file.`);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`${label} file must not be accessible by group or others.`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`${label} file is not owned by the current user.`);
    }
    if (stat.size < 1 || stat.size > MAX_PRIVATE_CREDENTIAL_BYTES + 1) {
      throw new Error(`${label} file has an invalid size.`);
    }
    const buffer = Buffer.alloc(MAX_PRIVATE_CREDENTIAL_BYTES + 2);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PRIVATE_CREDENTIAL_BYTES + 1) {
      throw new Error(`${label} file has an invalid size.`);
    }
    const contents = buffer.subarray(0, bytesRead).toString("utf8");
    const value = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
    validateCredential(value, label);
    return value;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
