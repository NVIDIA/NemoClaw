// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function treeContainsLiteral(root: string, literal: string): boolean {
  return fs
    .readdirSync(root, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .some((entry) => fileContainsLiteral(path.join(root, entry), literal));
}

function fileContainsLiteral(file: string, literal: string): boolean {
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return fs.fstatSync(handle).isFile() && fs.readFileSync(handle, "utf8").includes(literal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return false;
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}
