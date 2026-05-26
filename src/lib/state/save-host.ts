// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export interface SaveHostResult {
  ok: boolean;
  destination: string;
  message?: string;
}

export function saveBackupToHost(
  backupPath: string,
  destinationDir: string,
  cpImpl: typeof fs.cpSync = fs.cpSync,
  mkdirImpl: typeof fs.mkdirSync = fs.mkdirSync,
  homeDir: string = process.env.HOME || "",
): SaveHostResult {
  const resolved = resolveSaveHostPath(destinationDir, homeDir);
  const timestamp = path.basename(backupPath);
  const sandboxName = path.basename(path.dirname(backupPath));
  const targetParent = path.join(resolved, sandboxName);
  const target = path.join(targetParent, timestamp);
  try {
    mkdirImpl(targetParent, { recursive: true });
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
