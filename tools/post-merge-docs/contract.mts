// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export function allowedDocumentationPath(file: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/u.test(file) &&
    Buffer.byteLength(file) <= 512 &&
    file !== "docs/_build" &&
    !file.startsWith("docs/_build/") &&
    /^(?:docs\/|fern\/(?:docs[.]yml$|assets\/))/u.test(file) &&
    !file.includes("//") &&
    !/(?:^|\/)(?:\.{1,2}|\.git|\.gitattributes|\.gitmodules|node_modules)(?:\/|$)/u.test(file) &&
    !file.endsWith("/")
  );
}

export function readBoundedFile(file: string, maximum: number, allowEmpty = false): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum || (!allowEmpty && !stat.size))
      throw new Error(`${file} must be a bounded regular file`);
    const content = fs.readFileSync(descriptor);
    if (content.length !== stat.size) throw new Error(`${file} changed while read`);
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}
