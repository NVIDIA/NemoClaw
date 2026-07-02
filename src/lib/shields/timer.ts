// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Auto-restore timer for shields-down. Runs as a detached child process
// forked by shields.ts. Sleeps until the absolute restore time, then
// restores the captured policy snapshot.
//
// Usage (internal — called by shields.ts via fork()):
//   node shields-timer.js <sandbox-name> <snapshot-path> <restore-at-iso> <config-path> <config-dir> <process-token> <allow-legacy-hermes>

import fs from "node:fs";
import path from "node:path";
import { isRecord, type UnknownRecord } from "../core/json-types";
import { buildPolicySetCommand } from "../policy";
import { run } from "../runner";
import { resolveAgentConfig } from "../sandbox/config";
import { resolveNemoclawStateDir } from "../state/paths";
import { appendAuditEntry, type ShieldsAuditEntry } from "./audit";
import * as shields from "./index";
import { relockAndReconfirm } from "./relock-reconfirm";
import { isProcessAlive, readProcessStartIdentity } from "./timer-control";
import { withShieldsTransitionLock } from "./transition-lock";

interface ShieldsStatePatch {
  shieldsDown?: boolean;
  shieldsDownAt?: string | null;
  shieldsDownTimeout?: number | null;
  shieldsDownReason?: string | null;
  shieldsDownPolicy?: string | null;
  chattrApplied?: boolean;
  fileHashes?: { [path: string]: string };
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
  processToken?: string;
  allowLegacyHermesProtocol: boolean;
  leaseOwnerPid?: number;
  leaseOwnerStartIdentity?: string;
}

type LockAgentConfig = typeof shields.lockAgentConfig;

const STATE_DIR = resolveNemoclawStateDir();
const AUTO_RESTORE_RETRY_MS = 5_000;

function parseTimerArgs(argv: string[]): TimerArgs | null {
  const [
    sandboxName,
    snapshotPath,
    restoreAtIso,
    configPath,
    configDir,
    processToken,
    allowLegacyHermes,
    leaseOwnerPidRaw,
    leaseOwnerStartIdentityRaw,
  ] = argv;
  const restoreAtMs = restoreAtIso ? new Date(restoreAtIso).getTime() : Number.NaN;
  const leaseOwnerPid = leaseOwnerPidRaw ? Number(leaseOwnerPidRaw) : undefined;
  const leaseOwnerStartIdentity = leaseOwnerStartIdentityRaw || undefined;

  if (
    !sandboxName ||
    !snapshotPath ||
    !restoreAtIso ||
    Number.isNaN(restoreAtMs) ||
    (allowLegacyHermes !== undefined && allowLegacyHermes !== "0" && allowLegacyHermes !== "1") ||
    ((leaseOwnerPidRaw || leaseOwnerStartIdentityRaw) &&
      (!Number.isInteger(leaseOwnerPid) || Number(leaseOwnerPid) <= 0 || !leaseOwnerStartIdentity))
  ) {
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
    processToken,
    allowLegacyHermesProtocol: allowLegacyHermes === "1",
    ...(leaseOwnerPid && leaseOwnerStartIdentity ? { leaseOwnerPid, leaseOwnerStartIdentity } : {}),
  };
}

function appendAudit(entry: ShieldsAuditEntry): void {
  try {
    appendAuditEntry(entry);
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
  const current = readStateFile(stateFile);
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  const parent = path.dirname(stateFile);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    parent,
    `.${path.basename(stateFile)}.${String(process.pid)}.${Date.now().toString(16)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(updated, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, stateFile);
    const parentFd = fs.openSync(parent, "r");
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original state-commit failure.
    }
  }
}

function readTimerMarker(markerPath: string): UnknownRecord | null {
  try {
    if (!fs.existsSync(markerPath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function markerRecordMatchesCurrentTimer(marker: UnknownRecord | null, args: TimerArgs): boolean {
  if (!marker) return false;
  return (
    marker.pid === process.pid &&
    marker.sandboxName === args.sandboxName &&
    marker.snapshotPath === args.snapshotPath &&
    marker.restoreAt === args.restoreAtIso &&
    marker.processToken === args.processToken &&
    (marker.allowLegacyHermesProtocol === true) === args.allowLegacyHermesProtocol &&
    marker.leaseOwnerPid === args.leaseOwnerPid &&
    marker.leaseOwnerStartIdentity === args.leaseOwnerStartIdentity
  );
}

function cleanupOwnedTimerMarker(args: TimerArgs): boolean {
  const quarantinePath = `${args.markerPath}.completed-${String(process.pid)}-${Date.now().toString(16)}`;
  try {
    fs.renameSync(args.markerPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  if (markerRecordMatchesCurrentTimer(readTimerMarker(quarantinePath), args)) {
    fs.unlinkSync(quarantinePath);
    return true;
  }

  // We moved a replacement marker, not our authority record. Restore it only
  // if no newer canonical marker exists; link cannot overwrite a concurrent
  // timer generation.
  try {
    fs.linkSync(quarantinePath, args.markerPath);
    fs.unlinkSync(quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Preserve the quarantined record for explicit inspection rather than
    // deleting either timer generation.
  }
  return false;
}

function resolveLockAgentConfig(): LockAgentConfig {
  // The timer is a detached child process that must never mark shields up
  // unless it can call the lock verifier. Guard the CommonJS export boundary
  // so packaging/mock drift leaves shields down with an auditable warning.
  const lockAgentConfig = shields.lockAgentConfig;
  if (typeof lockAgentConfig !== "function") {
    throw new Error("Shields lock helper is unavailable; cannot verify auto-restore lock state");
  }
  return lockAgentConfig;
}

function markerMatchesCurrentTimer(args: TimerArgs): boolean {
  return markerRecordMatchesCurrentTimer(readTimerMarker(args.markerPath), args);
}

function rebuildLeaseOwnerIsCurrent(args: TimerArgs): boolean {
  if (!args.leaseOwnerPid || !args.leaseOwnerStartIdentity) return false;
  return (
    isProcessAlive(args.leaseOwnerPid) &&
    readProcessStartIdentity(args.leaseOwnerPid) === args.leaseOwnerStartIdentity
  );
}

function runRestoreTimer(args: TimerArgs): void {
  const now = new Date().toISOString();
  let exitCode = 0;
  let retryScheduled = false;
  const scheduleRetry = (): boolean => {
    if (!markerMatchesCurrentTimer(args)) return false;
    retryScheduled = true;
    setTimeout(() => runRestoreTimer(args), AUTO_RESTORE_RETRY_MS);
    return true;
  };

  try {
    // Timer markers are the source of authority. If the marker was removed or
    // replaced (e.g., destroy-time neutralization), this process must not
    // restore policy or rewrite shields state.
    if (!markerMatchesCurrentTimer(args)) {
      return;
    }

    // A rebuild can legitimately span the nominal 30-minute deadline while
    // its old sandbox is deleted and the replacement is still being created.
    // Bind that extension to the exact host PID/start identity. If the rebuild
    // dies, the lease expires immediately and this same detached owner keeps
    // retrying until it can restore the named sandbox.
    if (rebuildLeaseOwnerIsCurrent(args)) {
      scheduleRetry();
      return;
    }

    if (!args.processToken || !/^[0-9a-f]{32}$/.test(args.processToken)) {
      throw new Error("Auto-restore timer has no valid transition takeover token");
    }
    shields.prepareAutoRestoreTransitionTakeover(
      args.sandboxName,
      args.processToken,
      args.snapshotPath,
    );

    withShieldsTransitionLock(
      args.sandboxName,
      "shields auto-restore",
      () => {
        // A manual hardening command may have completed while this timer waited
        // for the host mutation lock. The marker is the timer's authority, so
        // re-check it only after serialization is established.
        if (!markerMatchesCurrentTimer(args)) return;

        if (!fs.existsSync(args.snapshotPath)) {
          appendAudit({
            action: "shields_up_failed",
            sandbox: args.sandboxName,
            timestamp: now,
            restored_by: "auto_timer",
            error: "Policy snapshot file missing",
          });
          exitCode = 1;
          scheduleRetry();
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
          scheduleRetry();
          return;
        }

        // Destroy and force-restore can revoke this marker while a slow
        // policy restore is already in flight. Stop before the next sandbox
        // mutation if this timer generation no longer owns recovery.
        if (!markerMatchesCurrentTimer(args)) return;

        // Re-lock config file using the shared lockAgentConfig from shields.ts.
        // lockAgentConfig runs each operation independently and verifies the
        // on-disk state — it throws if verification fails.
        //
        // NC-2227-03: Resolve the full agent config target (including sensitive
        // files like .config-hash, .env) so the timer re-locks the same scope
        // that interactive `shields up` uses. Fall back to the bare configPath/
        // configDir from argv if resolution fails (e.g., registry unavailable).
        let lockVerified = true;
        let lockedChattr: boolean | null = null;
        let lockedHashes: { [path: string]: string } | null = null;
        if (args.configPath) {
          let lockTarget: {
            agentName?: string;
            configPath: string;
            configDir: string;
            sensitiveFiles?: string[];
          } | null = null;
          try {
            // Always prefer the resolved target — even DEFAULT_AGENT_CONFIG
            // carries the OpenClaw sensitiveFiles (.config-hash) that
            // shields-up locks and that the content seal hashes. Dropping
            // them here would persist a partial fileHashes map and the next
            // `shields status` would flag the missing entries as drift.
            lockTarget = resolveAgentConfig(args.sandboxName);
          } catch {
            // Resolver itself threw (registry unavailable). Fall back to
            // argv-supplied paths, but still infer sensitiveFiles from
            // configDir so the locked set matches what shields-up uses.
            if (args.configDir) {
              lockTarget = {
                configPath: args.configPath,
                configDir: args.configDir,
                sensitiveFiles: [`${args.configDir}/.config-hash`],
              };
            } else {
              lockVerified = false;
              appendAudit({
                action: "shields_auto_restore_lock_warning",
                sandbox: args.sandboxName,
                timestamp: now,
                restored_by: "auto_timer",
                warning: "Missing config directory for auto-restore re-lock verification",
                lock_verified: false,
              });
            }
          }
          if (lockTarget) {
            try {
              if (!markerMatchesCurrentTimer(args)) return;
              const lockAgentConfig = resolveLockAgentConfig();
              // #4663: a single instantaneous lock+verify cannot prove an
              // in-sandbox reconciler didn't re-permission .config-hash after the
              // verified lock returned. Re-confirm the lock held once the gateway
              // has settled, re-applying if it drifted. This narrows (does not
              // close) the revert window; fail closed (leave shields DOWN + audit)
              // when the lock will not re-confirm within the retry budget.
              const relock = relockAndReconfirm(() =>
                lockAgentConfig(
                  args.sandboxName,
                  lockTarget,
                  false,
                  args.allowLegacyHermesProtocol,
                ),
              );
              if (relock.ok && relock.lastResult) {
                lockedChattr = relock.lastResult.chattrApplied;
                lockedHashes = relock.lastResult.fileHashes;
              } else {
                lockVerified = false;
                appendAudit({
                  action: "shields_auto_restore_lock_warning",
                  sandbox: args.sandboxName,
                  timestamp: now,
                  restored_by: "auto_timer",
                  warning: relock.error ?? "Config re-lock did not re-confirm after settle window",
                  lock_verified: false,
                });
              }
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
        }

        // Re-lock verification includes a settle window. Do not rewrite state
        // or remove a replacement marker if authority changed while it ran.
        if (!markerMatchesCurrentTimer(args)) return;

        // Only mark shields as UP if the lock was verified (or no config path).
        if (lockVerified) {
          const patch: ShieldsStatePatch = {
            shieldsDown: false,
            shieldsDownAt: null,
            shieldsDownTimeout: null,
            shieldsDownReason: null,
            shieldsDownPolicy: null,
          };
          if (lockedChattr !== null) patch.chattrApplied = lockedChattr;
          if (lockedHashes !== null) patch.fileHashes = lockedHashes;
          updateState(args.stateFile, patch);

          appendAudit({
            action: "shields_auto_restore",
            sandbox: args.sandboxName,
            timestamp: now,
            restored_by: "auto_timer",
            policy_snapshot: args.snapshotPath,
            scheduled_restore_at: args.restoreAtIso,
          });
          cleanupOwnedTimerMarker(args);
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
        scheduleRetry();
      },
      { takeoverToken: args.processToken },
    );
  } catch (error: unknown) {
    appendAudit({
      action: "shields_up_failed",
      sandbox: args.sandboxName,
      timestamp: now,
      restored_by: "auto_timer",
      error: error instanceof Error ? error.message : String(error),
    });
    exitCode = 1;
    scheduleRetry();
  } finally {
    if (!retryScheduled) process.exit(exitCode);
  }
}

function main(): void {
  const args = parseTimerArgs(process.argv.slice(2));
  if (!args) {
    process.exit(1);
  }

  let scheduled = false;
  const authorize = (): void => {
    if (scheduled || !markerMatchesCurrentTimer(args)) return;
    scheduled = true;
    setTimeout(
      () => {
        runRestoreTimer(args);
      },
      Math.max(0, args.restoreAtMs - Date.now()),
    );
  };

  // The parent publishes the PID/token marker before authorizing this child.
  // Without this barrier a short timeout can fire in the fork-to-marker gap,
  // causing the child to exit before the parent records a now-dead timer PID.
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "authorize" &&
      (message as { processToken?: unknown }).processToken === args.processToken
    ) {
      authorize();
    }
  });
  process.once("disconnect", authorize);
}

if (require.main === module) {
  main();
}

export {
  cleanupOwnedTimerMarker,
  markerMatchesCurrentTimer,
  parseTimerArgs,
  readTimerMarker,
  runRestoreTimer,
};
