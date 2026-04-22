// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Auto-restore timer for shields-down. Runs as a detached child process
// forked by shields.ts. Sleeps until the absolute restore time, then
// restores the captured policy snapshot.
//
// Usage (internal — called by shields.ts via fork()):
//   node shields-timer.js <sandbox-name> <snapshot-path> <restore-at-iso> <config-path> <config-dir>

const fs = require("fs");
const path = require("path");
const { run } = require("./runner");
const { buildPolicySetCommand } = require("./policies");
const { lockAgentConfig } = require("./shields");

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "state");
const AUDIT_FILE = path.join(STATE_DIR, "shields-audit.jsonl");

const [sandboxName, snapshotPath, restoreAtIso, configPath, configDir] = process.argv.slice(2);
const STATE_FILE = path.join(STATE_DIR, `shields-${sandboxName}.json`);
const restoreAtMs = new Date(restoreAtIso).getTime();
const delayMs = Math.max(0, restoreAtMs - Date.now());

if (!sandboxName || !snapshotPath || !restoreAtIso || isNaN(restoreAtMs)) {
  process.exit(1);
}

function appendAudit(entry) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // Best effort — don't crash the timer
  }
}

function updateState(patch) {
  try {
    let current = {};
    if (fs.existsSync(STATE_FILE)) {
      current = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch {
    // Best effort
  }
}

function cleanupMarker() {
  try {
    const markerPath = path.join(STATE_DIR, `shields-timer-${sandboxName}.json`);
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch {
    // Best effort
  }
}

setTimeout(() => {
  const now = new Date().toISOString();

  try {
    // Verify snapshot still exists
    if (!fs.existsSync(snapshotPath)) {
      appendAudit({
        action: "shields_up_failed",
        sandbox: sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        error: "Policy snapshot file missing",
      });
      cleanupMarker();
      process.exit(1);
    }

    // Restore policy (slow — openshell policy set --wait blocks)
    const result = run(buildPolicySetCommand(snapshotPath, sandboxName), { ignoreError: true });

    if (result.status !== 0) {
      appendAudit({
        action: "shields_up_failed",
        sandbox: sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        error: `Policy restore exited with status ${result.status}`,
      });
      cleanupMarker();
      process.exit(1);
    }

    // Re-lock config file using the shared lockAgentConfig from shields.ts.
    // lockAgentConfig runs each operation independently and verifies the
    // on-disk state — it throws if verification fails.
    let lockVerified = true;
    if (configPath) {
      try {
        lockAgentConfig(sandboxName, { configPath, configDir });
      } catch (lockErr) {
        lockVerified = false;
        appendAudit({
          action: "shields_auto_restore_lock_warning",
          sandbox: sandboxName,
          timestamp: now,
          restored_by: "auto_timer",
          warning: lockErr?.message ?? String(lockErr),
          lock_verified: false,
        });
      }
    }

    // Only mark shields as UP if the lock was verified (or no config path)
    if (lockVerified) {
      updateState({
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
      });

      appendAudit({
        action: "shields_auto_restore",
        sandbox: sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        policy_snapshot: snapshotPath,
      });
    } else {
      // Explicitly ensure state reflects shields are still DOWN.
      // shieldsDown() already wrote shieldsDown: true, but be explicit
      // rather than relying on the absence of an update.
      updateState({ shieldsDown: true });
      appendAudit({
        action: "shields_up_failed",
        sandbox: sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        error: "Config re-lock verification failed — shields remain DOWN",
      });
      cleanupMarker();
      process.exit(1);
    }
  } catch (err) {
    appendAudit({
      action: "shields_up_failed",
      sandbox: sandboxName,
      timestamp: now,
      restored_by: "auto_timer",
      error: err?.message ?? String(err),
    });
    cleanupMarker();
    process.exit(1);
  } finally {
    cleanupMarker();
    process.exit(0);
  }
}, delayMs);
