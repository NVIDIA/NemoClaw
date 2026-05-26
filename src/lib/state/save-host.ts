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
  realpathImpl: (target: string) => string = fs.realpathSync.native,
): SaveHostResult {
  const resolved = resolveSaveHostPath(destinationDir, homeDir);
  const timestamp = path.basename(backupPath);
  const sandboxName = path.basename(path.dirname(backupPath));
  const targetParent = path.join(resolved, sandboxName);
  const target = path.join(targetParent, timestamp);
  if (homeDir) {
    const stateDir = path.resolve(homeDir, ".nemoclaw");
    let realStateDir: string;
    try {
      realStateDir = realpathImpl(stateDir);
    } catch {
      realStateDir = stateDir;
    }
    if (isInsideNemoclawStateDir(resolved, stateDir, realStateDir, realpathImpl)) {
      return {
        ok: false,
        destination: target,
        message: `Refusing to save backups under ${stateDir} (or any symlink that resolves there): 'nemoclaw uninstall' wipes that tree, defeating the purpose of --save-host. Pick a path outside ~/.nemoclaw.`,
      };
    }
  }
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

function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function realpathOfExistingAncestor(
  target: string,
  realpathImpl: (target: string) => string,
): string {
  let current = path.resolve(target);
  while (true) {
    try {
      return realpathImpl(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return current;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function isInsideNemoclawStateDir(
  candidate: string,
  stateDir: string,
  realStateDir: string,
  realpathImpl: (target: string) => string,
): boolean {
  if (isUnder(candidate, stateDir)) return true;
  const realCandidate = realpathOfExistingAncestor(candidate, realpathImpl);
  if (isUnder(realCandidate, realStateDir)) return true;
  return isUnder(realCandidate, stateDir);
}
