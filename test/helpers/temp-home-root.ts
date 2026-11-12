// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a temporary directory under the real (symlink-resolved) home directory.
 *
 * State-root authority checks reject a fixture whose ancestry is group- or
 * world-writable, and shared temp roots are commonly world-writable, so a
 * fixture that stands in for a real home must not live under `os.tmpdir()`.
 * Resolving the home path first keeps the fixture's ancestry identical to the
 * ancestry the production check walks for a real user.
 *
 * The caller owns removal; pair every call with `fs.rmSync(root, { force: true,
 * recursive: true })` in a `finally` block.
 */
export function mkdtempUnderHome(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), prefix));
}
