// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

interface PrepareNonRootChildProcessOptions {
  enabled: boolean;
  ownedPaths: readonly string[];
  traversalRoot: string;
}

export function prepareNonRootChildProcess({
  enabled,
  ownedPaths,
  traversalRoot,
}: PrepareNonRootChildProcessOptions): { uid?: number; gid?: number } {
  if (!enabled || process.getuid?.() !== 0) return {};

  const uid = 65_534;
  fs.chmodSync(traversalRoot, 0o755);
  for (const ownedPath of ownedPaths) fs.chownSync(ownedPath, uid, uid);
  return { uid, gid: uid };
}
