// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  deleteSnapshot,
  isSnapshotPathInsideSnapshotsDir,
  listSnapshots,
  pruneSnapshots,
  snapshotDeletionSupported,
} from "./snapshot-management.js";
import type { SnapshotManagementOptions } from "./snapshot-management.js";

export interface SnapshotCommandOptions extends SnapshotManagementOptions {
  platform?: NodeJS.Platform;
}

type SnapshotsAction = "list" | "prune" | "delete";

function isSnapshotsAction(value: string | undefined): value is SnapshotsAction {
  return value === "list" || value === "prune" || value === "delete";
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function snapshotOutput(value: string): string {
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "?");
  return stripped.length > 500 ? `${stripped.slice(0, 500)}...` : stripped;
}

function snapshotsUsage(): string {
  return (
    "Usage: snapshots <list|prune|delete> [options]\n" +
    "\n" +
    "Subcommands:\n" +
    "  list                         List all snapshots\n" +
    "  prune --keep <N>             Keep N most recent snapshots, delete the rest\n" +
    "  delete --path <path>         Delete a specific snapshot by path\n" +
    "\n" +
    "Examples:\n" +
    "  snapshots list\n" +
    "  snapshots prune --keep 3\n" +
    "  snapshots delete --path ~/.nemoclaw/snapshots/20260101T000000Z\n"
  );
}

function requireSnapshotDeletionSupport(platform?: NodeJS.Platform): void {
  if (!snapshotDeletionSupported(platform)) {
    throw new Error("Snapshot deletion is not supported on native Windows; use WSL.");
  }
}

export function actionSnapshots(argv: string[], options: SnapshotCommandOptions = {}): void {
  const subcommand = argv.at(0);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    log(snapshotsUsage());
    return;
  }

  if (!isSnapshotsAction(subcommand)) {
    throw new Error(`Unknown snapshots subcommand '${subcommand}'. Use: list, prune, delete`);
  }

  switch (subcommand) {
    case "list": {
      const snapshots = listSnapshots(options);
      if (snapshots.length === 0) {
        log("No snapshots found.");
        return;
      }
      log(`Found ${snapshots.length} snapshot(s):\n`);
      for (const snapshot of snapshots) {
        log(`  ${snapshotOutput(snapshot.timestamp)}`);
        log(`    Path:       ${snapshotOutput(snapshot.path)}`);
        log(`    Source:     ${snapshotOutput(snapshot.source)}`);
        log(`    Files:      ${snapshot.file_count}`);
        log("");
      }
      break;
    }
    case "prune": {
      let keep = -1;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === "--keep") {
          const value = argv[++i];
          if (value === undefined) throw new Error("--keep requires a numeric value");
          if (!/^(?:0|[1-9]\d*)$/.test(value)) {
            throw new Error("--keep must be a non-negative integer");
          }
          const parsedKeep = Number.parseInt(value, 10);
          if (!Number.isSafeInteger(parsedKeep)) {
            throw new Error("--keep must be a non-negative integer");
          }
          keep = parsedKeep;
        }
      }
      if (keep < 0) throw new Error("--keep is required for prune");
      requireSnapshotDeletionSupport(options.platform);

      const { deleted, kept, failed } = pruneSnapshots(keep, options);
      if (deleted.length === 0 && failed.length === 0) {
        log(`Nothing to prune. ${kept.length} snapshot(s) kept (--keep=${String(keep)}).`);
        return;
      }
      if (deleted.length > 0) {
        log(`Pruned ${deleted.length} snapshot(s), kept ${kept.length}:\n`);
        for (const path of deleted) {
          log(`  Deleted: ${snapshotOutput(path)}`);
        }
      }
      if (failed.length > 0) {
        for (const path of failed) {
          log(`  Failed:  ${snapshotOutput(path)}`);
        }
        throw new Error(`Failed to prune ${failed.length} snapshot(s)`);
      }
      break;
    }
    case "delete": {
      let snapshotPath: string | undefined;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === "--path") {
          snapshotPath = argv[++i];
        }
      }
      if (!snapshotPath) throw new Error("--path is required for delete");
      if (!isSnapshotPathInsideSnapshotsDir(snapshotPath, options)) {
        throw new Error("Snapshot path must be inside the snapshots directory");
      }
      requireSnapshotDeletionSupport(options.platform);

      if (deleteSnapshot(snapshotPath, options)) {
        log(`Deleted snapshot: ${snapshotOutput(snapshotPath)}`);
      } else {
        throw new Error(`Failed to delete snapshot: ${snapshotOutput(snapshotPath)}`);
      }
      break;
    }
  }
}
