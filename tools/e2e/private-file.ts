// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = fs.constants.O_NONBLOCK ?? 0;

function openPrivateFileForWrite(file: string): number {
  try {
    return fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW | NON_BLOCK,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return fs.openSync(file, fs.constants.O_WRONLY | NO_FOLLOW | NON_BLOCK);
  }
}

export function readPrivateRegularFile(
  file: string,
  options: { allowMissing?: boolean; maxBytes: number },
): string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (error) {
    if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`${file} must be a private regular file`);
    }
    if (stat.size > options.maxBytes) {
      throw new Error(`${file} exceeds ${options.maxBytes} bytes`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writePrivateRegularFile(file: string, contents: string): void {
  const descriptor = openPrivateFileForWrite(file);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`${file} must be a private regular file`);
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
