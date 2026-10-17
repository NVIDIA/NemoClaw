// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { ensureConfigDir } from "../../state/config-io";

/** Write portable host configuration through the retained regular-file descriptor. */
export function writePrivateConfig(filePath: string, value: string): void {
  ensureConfigDir(path.dirname(filePath));
  let file;
  try {
    file = openRegularFileNoFollow(filePath, { writable: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    file = openRegularFileNoFollow(filePath, { create: true, mode: 0o600, writable: true });
  }
  try {
    file.replaceUtf8(value, 0o600);
  } finally {
    file.close();
  }
}
