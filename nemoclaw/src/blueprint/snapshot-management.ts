// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { deleteSnapshotDirectory, snapshotDeletionSupported } from "./snapshot-delete-helper.js";

const SNAPSHOT_DIR_NAME_RE = /^\d{8}T\d{6}Z$/;

export { snapshotDeletionSupported };

export interface BlueprintSnapshotManifest {
  timestamp: string;
  source: string;
  file_count: number;
  contents: string[];
  path: string;
}

export interface SnapshotManagementOptions {
  snapshotsDir?: string;
  deleteDirectory?: typeof deleteSnapshotDirectory;
}

type SnapshotManifestJson = {
  timestamp?: string;
  source?: string;
  file_count?: number;
  contents?: Array<string | null>;
};

function isSnapshotManifestJson(value: object | null): value is SnapshotManifestJson {
  return value !== null && !Array.isArray(value);
}

function readStringArray(value: SnapshotManifestJson["contents"]): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function snapshotsDirectory(options: SnapshotManagementOptions): string {
  return options.snapshotsDir ?? join(homedir(), ".nemoclaw", "snapshots");
}

function snapshotNameFromPath(snapshotPath: string, snapshotsDir: string): string | null {
  const relToSnapshots = relative(resolve(snapshotsDir), resolve(snapshotPath));
  if (relToSnapshots === "" || relToSnapshots.startsWith("..") || isAbsolute(relToSnapshots)) {
    return null;
  }
  const parts = relToSnapshots.split(/[\\/]+/);
  if (parts.length !== 1 || !SNAPSHOT_DIR_NAME_RE.test(parts[0] ?? "")) {
    return null;
  }
  return parts[0] ?? null;
}

export function deleteSnapshot(
  snapshotPath: string,
  options: SnapshotManagementOptions = {},
): boolean {
  const snapshotsDir = snapshotsDirectory(options);
  const snapshotName = snapshotNameFromPath(snapshotPath, snapshotsDir);
  // Deletion deliberately does not reuse snapshot.ts's point-in-time
  // rejectSymlinksOnPath check. The helper freshly opens the root, target, and
  // every descendant fd-relative with O_NOFOLLOW so path swaps also fail closed.
  return (
    snapshotName !== null &&
    (options.deleteDirectory ?? deleteSnapshotDirectory)(snapshotsDir, snapshotName)
  );
}

export function isSnapshotPathInsideSnapshotsDir(
  snapshotPath: string,
  options: SnapshotManagementOptions = {},
): boolean {
  return snapshotNameFromPath(snapshotPath, snapshotsDirectory(options)) !== null;
}

function readSnapshotManifest(
  snapDir: string,
  snapshotName: string,
): BlueprintSnapshotManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(snapDir, "snapshot.json"), "utf-8"));
    const raw = typeof parsed === "object" && parsed !== null ? parsed : null;
    if (!isSnapshotManifestJson(raw) || raw.timestamp !== snapshotName) {
      return null;
    }
    return {
      timestamp: snapshotName,
      source: typeof raw.source === "string" ? raw.source : "",
      file_count: typeof raw.file_count === "number" ? raw.file_count : 0,
      contents: readStringArray(raw.contents),
      path: snapDir,
    };
  } catch {
    return null;
  }
}

export function pruneSnapshots(
  keep: number,
  options: SnapshotManagementOptions = {},
): {
  deleted: string[];
  kept: string[];
  failed: string[];
} {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error("--keep must be a non-negative integer");
  }
  const snapshots = listSnapshots(options);
  if (snapshots.length <= keep) {
    return { deleted: [], kept: snapshots.map((snapshot) => snapshot.path), failed: [] };
  }

  const toDelete = snapshots.slice(keep);
  const toKeep = snapshots.slice(0, keep);
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const snapshot of toDelete) {
    if (deleteSnapshot(snapshot.path, options)) {
      deleted.push(snapshot.path);
    } else {
      failed.push(snapshot.path);
    }
  }

  return { deleted, kept: toKeep.map((snapshot) => snapshot.path), failed };
}

export function listSnapshots(
  options: SnapshotManagementOptions = {},
): BlueprintSnapshotManifest[] {
  const snapshotsDir = snapshotsDirectory(options);
  let entries: Dirent[];
  try {
    entries = readdirSync(snapshotsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const snapshots: BlueprintSnapshotManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SNAPSHOT_DIR_NAME_RE.test(entry.name)) {
      continue;
    }
    const snapDir = join(snapshotsDir, entry.name);
    const manifest = readSnapshotManifest(snapDir, entry.name);
    if (manifest !== null) {
      snapshots.push(manifest);
    }
  }

  return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
