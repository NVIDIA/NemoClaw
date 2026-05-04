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
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

/**
 * Reject a path if it — or any ancestor up to $HOME — is a symlink.
 * Prevents an attacker from planting a symlink at the target path to
 * redirect reads or writes to an attacker-controlled directory.
 *
 * Mirrors the pattern from src/lib/config-io.ts (PR #2290).
 */
function rejectSymlinksOnPath(targetPath: string): void {
  const resolvedHome = resolve(HOME);
  const resolved = resolve(targetPath);

  const relToHome = relative(resolvedHome, resolved);
  if (relToHome === "" || relToHome.startsWith("..") || isAbsolute(relToHome)) {
    return;
  }

  let current = resolved;
  while (current !== resolvedHome && current !== dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(current);
        throw new Error(
          `Refusing to operate on path: ${current} is a symbolic link ` +
            `(target: ${linkTarget}). This may indicate a symlink attack.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

function collectFiles(dir: string): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(relative(dir, full));
      } else if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return { files, symlinks };
}

export function createSnapshot(): string | null {
  if (!existsSync(OPENCLAW_DIR)) {
    return null;
  }

  // SECURITY: Verify source path is not a symlink before copying.
  // Without this check, an attacker who replaces ~/.openclaw with a symlink
  // to an arbitrary directory (e.g. /etc) could cause cpSync to copy
  // sensitive files into the snapshot.
  rejectSymlinksOnPath(OPENCLAW_DIR);

  const timestamp = compactTimestamp();
  const snapshotDir = join(SNAPSHOTS_DIR, timestamp);

  // SECURITY: Verify snapshot destination ancestors are not symlinks.
  rejectSymlinksOnPath(snapshotDir);

  mkdirSync(snapshotDir, { recursive: true });

  const dest = join(snapshotDir, "openclaw");
  cpSync(OPENCLAW_DIR, dest, { recursive: true });

  const { files, symlinks } = collectFiles(dest);
  const manifest: Record<string, unknown> = {
    timestamp,
    source: OPENCLAW_DIR,
    file_count: files.length,
    contents: files,
  };
  if (symlinks.length > 0) {
    manifest.symlinks = symlinks;
  }
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
  if (result.exitCode !== 0) {
    return false;
  }

  const repairLegacyLinks = await execa(
    "openshell",
    [
      "sandbox",
      "exec",
      sandboxName,
      "--",
      "bash",
      "-lc",
      `set -euo pipefail
root=/sandbox/.openclaw
[ -d "$root" ] || exit 0
find "$root" -type l -print0 | while IFS= read -r -d '' link; do
  target="$(readlink "$link" 2>/dev/null || true)"
  case "$target" in
    *".openclaw-data"*) ;;
    *) continue ;;
  esac
  rel="\${target#*/.openclaw-data/}"
  if [ "$rel" = "$target" ] || [ -z "$rel" ]; then
    rel="$(basename "$link")"
  fi
  candidate="$root/.openclaw-data/$rel"
  tmp="$link.materialized"
  rm -rf "$tmp"
  if [ -e "$candidate" ]; then
    cp -a "$candidate" "$tmp"
  else
    mkdir -p "$tmp"
  fi
  rm -f "$link"
  mv "$tmp" "$link"
done`,
    ],
    { reject: false },
  );
  if (repairLegacyLinks.exitCode !== 0) {
    console.debug(
      `legacy symlink repair in sandbox ${sandboxName} exited ${String(repairLegacyLinks.exitCode)}: ${repairLegacyLinks.stderr}`,
    );
  }

  // Files copied via `openshell sandbox cp` land as root:root because
  // the helper runs as root inside the pod. Fix ownership with a
  // best-effort recursive chown on the single config directory so the
  // sandbox user can write to agent state, workspace, etc. We
  // deliberately keep this best-effort (don't fail the restore if the
  // chown fails) so a future runtime that already gets ownership right
  // doesn't trip on a missing chown binary or a tightened exec policy.
  const chownResult = await execa(
    "openshell",
    ["sandbox", "exec", sandboxName, "--", "chown", "-R", "sandbox:sandbox", "/sandbox/.openclaw"],
    { reject: false },
  );
  if (chownResult.exitCode !== 0) {
    console.debug(
      `chown in sandbox ${sandboxName} exited ${String(chownResult.exitCode)}: ${chownResult.stderr}`,
    );
  }
  return true;
}

/**
 * Cross-device-safe move: try rename first (fast, same-device), fall back
 * to copy+delete when the source and destination are on different filesystems.
 *
 * This happens on NVIDIA self-hosted CI runners where Docker uses the
 * containerd overlayfs snapshotter — directories can span different overlay
 * layers, causing `rename(2)` to return EXDEV.
 */
export function moveSync(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

export function cutoverHost(): boolean {
  if (!existsSync(OPENCLAW_DIR)) {
    return true;
  }

  const archivePath = join(HOME, `.openclaw.pre-nemoclaw.${compactTimestamp()}`);
  try {
    moveSync(OPENCLAW_DIR, archivePath);
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
    // SECURITY: Verify restore destination is not a symlink before writing.
    // Without this check, an attacker who replaces ~/.openclaw with a symlink
    // could redirect snapshot contents to an arbitrary directory.
    // Inside the try/catch to preserve the boolean-return contract.
    rejectSymlinksOnPath(OPENCLAW_DIR);

    if (archivePath !== null) {
      moveSync(OPENCLAW_DIR, archivePath);
    }
    cpSync(source, OPENCLAW_DIR, { recursive: true });
    return true;
  } catch {
    // Restore archived config if copy failed so the host isn't left without .openclaw
    if (archivePath !== null && existsSync(archivePath) && !existsSync(OPENCLAW_DIR)) {
      moveSync(archivePath, OPENCLAW_DIR);
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
      const parsed: unknown = JSON.parse(readFileSync(join(snapDir, "snapshot.json"), "utf-8"));
      const raw = typeof parsed === "object" && parsed !== null ? parsed : null;
      if (!isSnapshotManifestJson(raw) || typeof raw.timestamp !== "string") continue;
      snapshots.push({
        timestamp: raw.timestamp,
        source: typeof raw.source === "string" ? raw.source : "",
        file_count: typeof raw.file_count === "number" ? raw.file_count : 0,
        contents: readStringArray(raw.contents),
        path: snapDir,
      });
    } catch {
      // Skip snapshots with missing or unreadable manifests
    }
  }

  return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
