// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration snapshot/restore logic for moving host OpenClaw into OpenShell sandbox.
 *
 * Handles:
 *   - Snapshot: capture ~/.openclaw config, workspace, extensions, skills
 *   - Restore: push snapshot contents into sandbox filesystem
 *   - Cutover: rename host config to archived, point OpenClaw at sandbox
 *   - Rollback: restore host config from snapshot
 */

import type { Dirent } from "node:fs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import { execa } from "execa";

const HOME = homedir();
const OPENCLAW_DIR = join(HOME, ".openclaw");
const NEMOCLAW_DIR = join(HOME, ".nemoclaw");
const SNAPSHOTS_DIR = join(NEMOCLAW_DIR, "snapshots");

function compactTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return files;
}

export function createSnapshot(): string | null {
  if (!existsSync(OPENCLAW_DIR)) {
    return null;
  }

  const timestamp = compactTimestamp();
  const snapshotDir = join(SNAPSHOTS_DIR, timestamp);
  mkdirSync(snapshotDir, { recursive: true });

  const dest = join(snapshotDir, "openclaw");
  cpSync(OPENCLAW_DIR, dest, { recursive: true });

  const contents = collectFiles(dest);
  const manifest = {
    timestamp,
    source: OPENCLAW_DIR,
    file_count: contents.length,
    contents,
  };
  writeFileSync(join(snapshotDir, "snapshot.json"), JSON.stringify(manifest, null, 2));

  return snapshotDir;
}

export async function restoreIntoSandbox(
  snapshotDir: string,
  sandboxName = "openclaw",
): Promise<boolean> {
  const source = join(snapshotDir, "openclaw");
  if (!existsSync(source)) {
    return false;
  }

  const result = await execa(
    "openshell",
    ["sandbox", "cp", source, `${sandboxName}:/sandbox/.openclaw`],
    { reject: false },
  );
  return result.exitCode === 0;
}

export function cutoverHost(): boolean {
  if (!existsSync(OPENCLAW_DIR)) {
    return true;
  }

  const archivePath = join(HOME, `.openclaw.pre-nemoclaw.${compactTimestamp()}`);
  try {
    renameSync(OPENCLAW_DIR, archivePath);
    return true;
  } catch {
    return false;
  }
}

export function rollbackFromSnapshot(snapshotDir: string): boolean {
  const source = join(snapshotDir, "openclaw");
  if (!existsSync(source)) {
    return false;
  }

  const archivePath = existsSync(OPENCLAW_DIR)
    ? join(HOME, `.openclaw.nemoclaw-archived.${compactTimestamp()}`)
    : null;

  try {
    if (archivePath !== null) {
      renameSync(OPENCLAW_DIR, archivePath);
    }
    cpSync(source, OPENCLAW_DIR, { recursive: true });
    return true;
  } catch {
    // Restore archived config if copy failed so the host isn't left without .openclaw
    if (archivePath !== null && existsSync(archivePath) && !existsSync(OPENCLAW_DIR)) {
      renameSync(archivePath, OPENCLAW_DIR);
    }
    return false;
  }
}

// Named BlueprintSnapshotManifest to avoid collision with migration-state.ts SnapshotManifest
export interface BlueprintSnapshotManifest {
  timestamp: string;
  source: string;
  file_count: number;
  contents: string[];
  path: string;
}

export function listSnapshots(): BlueprintSnapshotManifest[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(SNAPSHOTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const snapshots: BlueprintSnapshotManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const snapDir = join(SNAPSHOTS_DIR, entry.name);
    try {
      const raw: unknown = JSON.parse(readFileSync(join(snapDir, "snapshot.json"), "utf-8"));
      if (typeof raw !== "object" || raw === null) continue;
      const obj = raw as Record<string, unknown>;
      if (typeof obj.timestamp !== "string") continue;
      snapshots.push({
        timestamp: obj.timestamp,
        source: typeof obj.source === "string" ? obj.source : "",
        file_count: typeof obj.file_count === "number" ? obj.file_count : 0,
        contents: Array.isArray(obj.contents) ? (obj.contents as string[]) : [],
        path: snapDir,
      });
    } catch {
      // Skip snapshots with missing or unreadable manifests
    }
  }

  return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
