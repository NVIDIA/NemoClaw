// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function resolvePathWithinRoot(root: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a nonempty relative path`);
  }
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const resolved = path.resolve(canonicalRoot, relativePath);
  if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its repository root: ${relativePath}`);
  }
  let current = canonicalRoot;
  for (const component of path.relative(canonicalRoot, resolved).split(path.sep)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic-link component: ${relativePath}`);
    }
  }
  return resolved;
}
