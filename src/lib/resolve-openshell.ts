// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

export interface ResolveOpenshellOptions {
  /** Mock result for `command -v` (undefined = run real command). */
  commandVResult?: string | null;
  /** Override executable check (default: fs.accessSync X_OK). */
  checkExecutable?: (path: string) => boolean;
  /** HOME directory override. */
  home?: string;
}

/**
 * Resolve the openshell binary path.
 *
 * Checks `command -v` first (must return an absolute path to prevent alias
 * injection), then falls back to common installation directories.
 */
export function resolveOpenshell(opts: ResolveOpenshellOptions = {}): string | null {
  const home = opts.home ?? process.env.HOME;
  const checkExecutable =
    opts.checkExecutable ??
    ((p: string): boolean => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

  const override = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (override?.startsWith("/") && checkExecutable(override)) {
    return override;
  }

  // Step 1: command -v
  if (opts.commandVResult === undefined) {
    try {
      const found = execSync("command -v openshell", { encoding: "utf-8" }).trim();
      if (found.startsWith("/")) return found;
    } catch {
      /* ignored */
    }
  } else if (opts.commandVResult?.startsWith("/")) {
    return opts.commandVResult;
  }

  // Step 2: fallback candidates
  const candidates = [
    ...(home?.startsWith("/") ? [`${home}/.local/bin/openshell`] : []),
    "/usr/local/bin/openshell",
    "/usr/bin/openshell",
  ];
  for (const p of candidates) {
    if (checkExecutable(p)) return p;
  }

  return null;
}
