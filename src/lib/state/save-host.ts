// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export interface SaveHostResult {
  ok: boolean;
  destination: string;
  message?: string;
}

// Copy a single backup directory (the path returned by `backupSandboxState`)
// into a user-supplied host destination. The destination is created if it
// does not exist; the backup is laid down at `<destination>/<basename>` so
// repeated calls with the same destination accumulate per-snapshot
// subdirectories instead of overwriting. Resolves `~` and relative paths.
// See #4226 (`--save-host` flow, host-side workaround for the missing
// OpenShell `--mount`/`--volume` support that would otherwise let the
// sandbox workspace live on a persistent host volume).
export function saveBackupToHost(
  backupPath: string,
  destinationDir: string,
  cpImpl: typeof fs.cpSync = fs.cpSync,
  mkdirImpl: typeof fs.mkdirSync = fs.mkdirSync,
  homeDir: string = process.env.HOME || "",
): SaveHostResult {
  const resolved = resolveSaveHostPath(destinationDir, homeDir);
  const target = path.join(resolved, path.basename(backupPath));
  try {
    mkdirImpl(resolved, { recursive: true });
    cpImpl(backupPath, target, { recursive: true });
    return { ok: true, destination: target };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, destination: target, message };
  }
}

export function resolveSaveHostPath(raw: string, homeDir: string): string {
  if (raw.startsWith("~/")) {
    return path.resolve(homeDir, raw.slice(2));
  }
  if (raw === "~") {
    return path.resolve(homeDir);
  }
  return path.resolve(raw);
}
