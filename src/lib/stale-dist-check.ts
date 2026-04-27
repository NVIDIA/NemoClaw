// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Warn when compiled `dist/` is older than `src/` in a dev checkout.
 * `dist/` is gitignored, so a `git pull` that touches `src/` leaves the old
 * compiled output in place — see #1958, where a reverted BASE_IMAGE digest
 * patch in stale `dist/lib/onboard.js` produced a cryptic "manifest unknown".
 * In published npm installs there is no `src/`, so this no-ops.
 */

import fs from "fs";
import path from "path";

const GRACE_MS = 2000;

/** Return the newest mtime (ms) under `root` among files where `accept(name)` is true. Returns 0 if nothing matches or `root` is unreadable. */
export function maxMtime(root: string, accept: (name: string) => boolean): number {
  let newest = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (entry.isFile() && accept(entry.name)) {
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs > newest) newest = mtimeMs;
      }
    }
  }
  return newest;
}

/** Return `{ srcMtime, distMtime }` when compiled dist/ is older than src/ by more than the grace window; return null otherwise or when either directory is missing. */
export function checkStaleDist(repoRoot: string): { srcMtime: number; distMtime: number } | null {
  const srcDir = path.join(repoRoot, "src");
  const distDir = path.join(repoRoot, "dist");
  if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return null;

  const srcMtime = maxMtime(srcDir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const distMtime = maxMtime(distDir, (name) => name.endsWith(".js"));
  if (!srcMtime || !distMtime) return null;
  if (srcMtime <= distMtime + GRACE_MS) return null;

  return { srcMtime, distMtime };
}

/** Print a stale-dist warning to `stream` if dist/ is out of date. Returns true when a warning was emitted, false otherwise. Never throws — fails open on any error (filesystem or stream write). */
export function warnIfStale(
  repoRoot: string,
  stream: { write(chunk: string): void | boolean } = process.stderr,
): boolean {
  try {
    const result = checkStaleDist(repoRoot);
    if (!result) return false;
    stream.write(
      "Warning: compiled dist/ is older than src/ — you are running stale code.\n" +
        "  Run `npm run build:cli` to rebuild, then retry.\n" +
        "  (dist/ is gitignored, so `git pull` does not update it. See #1958.)\n",
    );
    return true;
  } catch {
    return false;
  }
}
