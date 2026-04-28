// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Auto-restore timer for shields-down. Runs as a detached child process
// forked by shields.ts. Sleeps until the absolute restore time, then
// restores the captured policy snapshot.
//
// Usage (internal — called by shields.ts via fork()):
//   node shields-timer.js <sandbox-name> <snapshot-path> <restore-at-iso> <config-path> <config-dir>

import fs from "node:fs";
import path from "node:path";

import { buildPolicySetCommand } from "./policies";
import { run } from "./runner";
import { lockAgentConfig } from "./shields";

type UnknownRecord = { [key: string]: unknown };

interface ShieldsStatePatch {
  shieldsDown?: boolean;
  shieldsDownAt?: string | null;
  shieldsDownTimeout?: number | null;
  shieldsDownReason?: string | null;
  shieldsDownPolicy?: string | null;
}

interface TimerArgs {
  sandboxName: string;
  snapshotPath: string;
  restoreAtIso: string;
  restoreAtMs: number;
  delayMs: number;
  stateFile: string;
  markerPath: string;
  configPath?: string;
  configDir?: string;
}

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "state");
const AUDIT_FILE = path.join(STATE_DIR, "shields-audit.jsonl");

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimerArgs(argv: string[]): TimerArgs | null {
  const [sandboxName, snapshotPath, restoreAtIso, configPath, configDir] = argv;
  const restoreAtMs = restoreAtIso ? new Date(restoreAtIso).getTime() : Number.NaN;

  if (!sandboxName || !snapshotPath || !restoreAtIso || Number.isNaN(restoreAtMs)) {
    return null;
  }

  return {
    sandboxName,
    snapshotPath,
    restoreAtIso,
    restoreAtMs,
    delayMs: Math.max(0, restoreAtMs - Date.now()),
    stateFile: path.join(STATE_DIR, `shields-${sandboxName}.json`),
    markerPath: path.join(STATE_DIR, `shields-timer-${sandboxName}.json`),
    configPath,
    configDir,
  };
}

function appendAudit(entry: UnknownRecord): void {
  try {
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Best effort — don't crash the timer
  }
}

function readStateFile(stateFile: string): UnknownRecord {
  try {
    if (!fs.existsSync(stateFile)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function updateState(stateFile: string, patch: ShieldsStatePatch): void {
  try {
    const current = readStateFile(stateFile);
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(stateFile, JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch {
    // Best effort
  }
}

function cleanupMarker(markerPath: string): void {
  try {
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch {
    // Best effort
  }
}

function runRestoreTimer(args: TimerArgs): void {
  const now = new Date().toISOString();
  let exitCode = 0;

  try {
    if (!fs.existsSync(args.snapshotPath)) {
      appendAudit({
        action: "shields_up_failed",
        sandbox: args.sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        error: "Policy snapshot file missing",
      });
      exitCode = 1;
      return;
    }

    // Restore policy (slow — openshell policy set --wait blocks)
    const result = run(buildPolicySetCommand(args.snapshotPath, args.sandboxName), {
      ignoreError: true,
    });
    const status = typeof result.status === "number" ? result.status : 1;

    if (status !== 0) {
      appendAudit({
        action: "shields_up_failed",
        sandbox: args.sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        error: `Policy restore exited with status ${String(status)}`,
      });
      exitCode = 1;
      return;
    }

    // Re-lock config file using the shared lockAgentConfig from shields.ts.
    // lockAgentConfig runs each operation independently and verifies the
    // on-disk state — it throws if verification fails.
    let lockVerified = true;
    const lockTarget = args.configPath && args.configDir
      ? { configPath: args.configPath, configDir: args.configDir }
      : null;

    if (args.configPath && !lockTarget) {
      lockVerified = false;
      appendAudit({
        action: "shields_auto_restore_lock_warning",
        sandbox: args.sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        warning: "Missing config directory for auto-restore re-lock verification",
        lock_verified: false,
      });
    } else if (lockTarget) {
      try {
        lockAgentConfig(args.sandboxName, lockTarget);
      } catch (error: unknown) {
        lockVerified = false;
        appendAudit({
          action: "shields_auto_restore_lock_warning",
          sandbox: args.sandboxName,
          timestamp: now,
          restored_by: "auto_timer",
          warning: error instanceof Error ? error.message : String(error),
          lock_verified: false,
        });
      }
    }

    // Only mark shields as UP if the lock was verified (or no config path).
    if (lockVerified) {
      updateState(args.stateFile, {
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
      });

      appendAudit({
        action: "shields_auto_restore",
        sandbox: args.sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        policy_snapshot: args.snapshotPath,
        restore_at: args.restoreAtIso,
      });
      return;
    }

    // Explicitly ensure state reflects shields are still DOWN.
    // shieldsDown() already wrote shieldsDown: true, but be explicit rather
    // than relying on the absence of an update.
    updateState(args.stateFile, { shieldsDown: true });
    appendAudit({
      action: "shields_up_failed",
      sandbox: args.sandboxName,
      timestamp: now,
      restored_by: "auto_timer",
      error: "Config re-lock verification failed — shields remain DOWN",
    });
    exitCode = 1;
  } catch (error: unknown) {
    appendAudit({
      action: "shields_up_failed",
      sandbox: args.sandboxName,
      timestamp: now,
      restored_by: "auto_timer",
      error: error instanceof Error ? error.message : String(error),
    });
    exitCode = 1;
  } finally {
    cleanupMarker(args.markerPath);
    process.exit(exitCode);
  }
}

function main(): void {
  const args = parseTimerArgs(process.argv.slice(2));
  if (!args) {
    process.exit(1);
  }

  setTimeout(() => {
    runRestoreTimer(args);
  }, args.delayMs);
}

if (require.main === module) {
  main();
}
