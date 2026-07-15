// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * prek post-merge / post-checkout hook entry.
 * Warns when compiled dist/ is older than src/ after a git operation that
 * changed source files but didn't rebuild dist (see #1958). Always exits 0
 * so the git operation is never blocked by this check.
 */

import { fileURLToPath } from "node:url";
import path from "path";

try {
  const { warnIfStale } = await import("../src/lib/stale-dist-check.ts");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  warnIfStale(repoRoot);
} catch {
  // Never block the git operation, even if the check itself crashes.
}
process.exit(0);
