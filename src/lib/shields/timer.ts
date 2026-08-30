// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Auto-restore timer for shields-down. Runs as a detached child process
// forked by shields.ts. Sleeps until the absolute restore time, then
// restores the captured policy snapshot.
//
// Usage (internal — called by shields.ts via fork()):
//   node shields-timer.js <sandbox-name> <snapshot-path> <restore-at-iso> <config-path> <config-dir> <process-token> <allow-legacy-hermes> <lease-owner-pid> <lease-owner-start> <agent-name>

import fs from "node:fs";
import path from "node:path";
import { CLI_NAME } from "../cli/branding";
import { isObjectRecord, type UnknownRecord } from "../core/json-types";
import {
  beginCommittedMcpLifecycleContainmentSync,
  durableMcpLifecycleContainmentFailure,
  getMcpLifecycleLockPath,
  withMcpLifecycleDeadlineFence,
} from "../state/mcp-lifecycle-lock";
import {
  readShieldsTimerMarkerFile,
  type ShieldsTimerMarker,
} from "../state/mcp-lifecycle-lock/shields-timer-authority";
import { resolveNemoclawStateDir } from "../state/paths";
import { appendAuditEntry, type ShieldsAuditEntry } from "./audit";
import * as shields from "./index";
import { relockAndReconfirm } from "./relock-reconfirm";
import {
  hasExactTimerAuthorizationProof,
  isProcessAlive,
  readProcessStartIdentity,
  removeTimerAuthorizationProof,
  writeTimerAuthorizationProofForMarker,
} from "./timer-control";
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
  agentName?: string;
  processToken?: string;
  allowLegacyHermesProtocol: boolean;
  leaseOwnerPid?: number;
  leaseOwnerStartIdentity?: string;
}

interface TimerRuntimeOptions {
  retryDelayMs?: number;
  maxRestoreAttempts?: number;
  deadlineSetupTimeoutMs?: number;
}

interface RecoveryAttemptBudget {
  attemptsUsed: number;
}

type LockAgentConfig = typeof shields.lockAgentConfig;
type RestoreAttemptOutcome = "complete" | "retry" | "revoked";

const STATE_DIR = resolveNemoclawStateDir();
const AUTO_RESTORE_RETRY_MS = 5_000;
const AUTO_RESTORE_MAX_ATTEMPTS = 7;
const AUTO_RESTORE_AUTHORITY_POLL_MS = 250;

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
    agentNameRaw,
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
    ...(agentNameRaw ? { agentName: agentNameRaw } : {}),
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

function isDurableContainmentFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === "NEMOCLAW_DURABLE_CONTAINMENT"
  );
}

function readStateFile(stateFile: string): UnknownRecord {
  try {
    if (!fs.existsSync(stateFile)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    return isObjectRecord(parsed) ? parsed : {};
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

function readTimerMarker(markerPath: string): ShieldsTimerMarker | null {
  return readShieldsTimerMarkerFile(markerPath);
}

let cachedCurrentProcessStartIdentity: string | undefined;

function currentProcessStartIdentity(): string | null {
  if (cachedCurrentProcessStartIdentity !== undefined) {
    return cachedCurrentProcessStartIdentity;
  }
  const identity = readProcessStartIdentity(process.pid);
  if (identity !== null) cachedCurrentProcessStartIdentity = identity;
  return identity;
}

function markerRecordMatchesCurrentTimer(
  marker: ShieldsTimerMarker | null,
  args: TimerArgs,
): boolean {
  if (!marker) return false;
  return (
    marker.pid === process.pid &&
    marker.sandboxName === args.sandboxName &&
    marker.snapshotPath === args.snapshotPath &&
    marker.restoreAt === args.restoreAtIso &&
    marker.processToken === args.processToken &&
    (marker.timerProcessStartIdentity === undefined ||
      marker.timerProcessStartIdentity === currentProcessStartIdentity()) &&
    (marker.allowLegacyHermesProtocol === true) === args.allowLegacyHermesProtocol &&
    marker.leaseOwnerPid === args.leaseOwnerPid &&
    marker.leaseOwnerStartIdentity === args.leaseOwnerStartIdentity &&
    marker.agentName === args.agentName &&
    (marker.configPath === undefined || marker.configPath === args.configPath) &&
    (marker.configDir === undefined || marker.configDir === args.configDir)
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
    removeTimerAuthorizationProof(args.sandboxName, args.processToken);
    const directoryFd = fs.openSync(path.dirname(args.markerPath), "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
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

async function runRestoreTimerWithBudget(
  args: TimerArgs,
  runtimeOptions: TimerRuntimeOptions,
  recoveryBudget: RecoveryAttemptBudget,
): Promise<void> {
  const retryDelayMs =
    Number.isFinite(runtimeOptions.retryDelayMs) && (runtimeOptions.retryDelayMs ?? 0) >= 0
      ? Math.floor(runtimeOptions.retryDelayMs!)
      : AUTO_RESTORE_RETRY_MS;
  const maxRestoreAttempts =
    Number.isInteger(runtimeOptions.maxRestoreAttempts) &&
    (runtimeOptions.maxRestoreAttempts ?? 0) > 0
      ? runtimeOptions.maxRestoreAttempts!
      : AUTO_RESTORE_MAX_ATTEMPTS;
  const deadlineSetupTimeoutMs =
    Number.isFinite(runtimeOptions.deadlineSetupTimeoutMs) &&
    (runtimeOptions.deadlineSetupTimeoutMs ?? 0) > 0
      ? Math.floor(runtimeOptions.deadlineSetupTimeoutMs!)
      : 5_000;
  let exitCode = 0;
  let retryScheduled = false;
  let terminalContainment = false;
  let restoreCompleted = false;
  let managedMcpWarning: string | undefined;
  const scheduleRetry = (): boolean => {
    if (!markerMatchesCurrentTimer(args)) return false;
    retryScheduled = true;
    setTimeout(() => {
      void runRestoreTimerWithBudget(args, runtimeOptions, recoveryBudget);
    }, retryDelayMs);
    return true;
  };
  const assertTakeoverAuthority = (): void => {
    if (!markerMatchesCurrentTimer(args)) {
      throw new Error("Auto-restore authority changed before Shields transition takeover");
    }
  };
  const terminalRecoveryFailure = (attempt: number): Error => {
    const lockPath = getMcpLifecycleLockPath(args.sandboxName, STATE_DIR);
    const reason = `Auto-restore recovery failed after ${String(attempt)} ${attempt === 1 ? "attempt" : "attempts"} while the exact timer generation still owned recovery authority`;
    try {
      beginCommittedMcpLifecycleContainmentSync(
        args.sandboxName,
        args.processToken!,
        reason,
        STATE_DIR,
        assertTakeoverAuthority,
      );
    } catch (error) {
      if (isDurableContainmentFailure(error)) return error as Error;
      if (!markerMatchesCurrentTimer(args)) {
        return error instanceof Error ? error : new Error(String(error));
      }
      const message = error instanceof Error ? error.message : String(error);
      return durableMcpLifecycleContainmentFailure(
        new Error(
          `${reason}; durable containment could not be committed: ${message}. Correct the state-directory write failure, then run \`${CLI_NAME} ${args.sandboxName} shields status\` to resume recovery or receive exact-generation recovery guidance`,
        ),
        lockPath,
        { retainOwnedLifecycleGates: true },
      );
    }
    return durableMcpLifecycleContainmentFailure(
      new Error(
        `${reason}. Durable containment now blocks sandbox mutations. Stop all NemoClaw processes for this sandbox, then follow the exact-generation recovery guidance from the next NemoClaw command.`,
      ),
      lockPath,
    );
  };
  const attemptsAtEntry = recoveryBudget.attemptsUsed;

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
    const restoreUnderDeadlineFence = (): RestoreAttemptOutcome =>
      withShieldsTransitionLock(
        args.sandboxName,
        "shields auto-restore",
        () => {
          // A manual hardening command may have completed while this timer waited
          // for the host mutation lock. The marker is the timer's authority, so
          // re-check it only after serialization is established.
          if (!markerMatchesCurrentTimer(args)) return "revoked";

          if (!fs.existsSync(args.snapshotPath)) {
            appendAudit({
              action: "shields_up_failed",
              sandbox: args.sandboxName,
              timestamp: new Date().toISOString(),
              restored_by: "auto_timer",
              error: "Policy snapshot file missing",
            });
            exitCode = 1;
            return "retry";
          }

          // Restore policy (slow — openshell policy set --wait blocks)
          const result = shields.applyShieldsPolicySnapshot(args.sandboxName, args.snapshotPath, {
            transitionProcessToken: args.processToken,
            deadlineAuthoritative: true,
          });
          const status = typeof result.status === "number" ? result.status : 1;
          managedMcpWarning = result.managedMcpOmissions?.length
            ? `Auto-restore omitted ${String(
                result.managedMcpOmissions.length,
              )} unproven managed MCP policy entries`
            : undefined;

          if (status !== 0) {
            appendAudit({
              action: "shields_up_failed",
              sandbox: args.sandboxName,
              timestamp: new Date().toISOString(),
              restored_by: "auto_timer",
              error: `Policy restore exited with status ${String(status)}`,
            });
            exitCode = 1;
            return "retry";
          }

          // Destroy and force-restore can revoke this marker while a slow
          // policy restore is already in flight. Stop before the next sandbox
          // mutation if this timer generation no longer owns recovery.
          if (!markerMatchesCurrentTimer(args)) return "revoked";

          // Re-lock config file using the shared lockAgentConfig from shields.ts.
          // lockAgentConfig runs each operation independently and verifies the
          // on-disk state — it throws if verification fails.
          //
          // NC-2227-03: Reuse resolved registry metadata only when configPath,
          // configDir, and the optional agentName match the timer arguments.
          // Otherwise the persisted paths remain the recovery authority. This
          // keeps older markers without agentName pinned by path while preserving
          // the full sensitive-file set whenever the registry still describes the
          // same target.
          let lockVerified = true;
          let lockedChattr: boolean | null = null;
          let lockedHashes: { [path: string]: string } | null = null;
          if (args.configPath) {
            const lockTarget = shields.resolvePersistedAutoRestoreTarget(args.sandboxName, args);
            if (!lockTarget) {
              lockVerified = false;
              appendAudit({
                action: "shields_auto_restore_lock_warning",
                sandbox: args.sandboxName,
                timestamp: new Date().toISOString(),
                restored_by: "auto_timer",
                warning: "Missing config directory for auto-restore re-lock verification",
                lock_verified: false,
              });
            }
            if (lockTarget) {
              try {
                if (!markerMatchesCurrentTimer(args)) return "revoked";
                const lockAgentConfig = resolveLockAgentConfig();
                // #4663: a single instantaneous lock+verify cannot prove an
                // in-sandbox reconciler didn't re-permission .config-hash after the
                // verified lock returned. Re-confirm the lock held once the gateway
                // has settled, re-applying if it drifted. This narrows (does not
                // close) the revert window; fail closed (leave shields DOWN + audit)
                // when the lock will not re-confirm within the retry budget.
                const protocol = shields.resolveHermesShieldsProtocol(
                  args.sandboxName,
                  lockTarget,
                  args.allowLegacyHermesProtocol,
                );
                const relock = relockAndReconfirm(
                  () =>
                    lockAgentConfig(
                      args.sandboxName,
                      lockTarget,
                      false,
                      args.allowLegacyHermesProtocol,
                      protocol,
                    ),
                  {
                    confirm: shields.hermesProviderLockConfirmation(
                      args.sandboxName,
                      lockTarget,
                      protocol,
                    ),
                  },
                );
                if (relock.ok && relock.lastResult) {
                  lockedChattr = relock.lastResult.chattrApplied;
                  lockedHashes = relock.lastResult.fileHashes;
                } else {
                  lockVerified = false;
                  appendAudit({
                    action: "shields_auto_restore_lock_warning",
                    sandbox: args.sandboxName,
                    timestamp: new Date().toISOString(),
                    restored_by: "auto_timer",
                    warning:
                      relock.error ?? "Config re-lock did not re-confirm after settle window",
                    lock_verified: false,
                  });
                }
              } catch (error: unknown) {
                lockVerified = false;
                appendAudit({
                  action: "shields_auto_restore_lock_warning",
                  sandbox: args.sandboxName,
                  timestamp: new Date().toISOString(),
                  restored_by: "auto_timer",
                  warning: error instanceof Error ? error.message : String(error),
                  lock_verified: false,
                });
              }
            }
          }

          // Re-lock verification includes a settle window. Do not rewrite state
          // or remove a replacement marker if authority changed while it ran.
          if (!markerMatchesCurrentTimer(args)) return "revoked";

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
            if (
              !shields.completeAutoRestoreTransition(
                args.sandboxName,
                args.processToken!,
                args.snapshotPath,
              )
            ) {
              return "revoked";
            }

            appendAudit({
              action: "shields_auto_restore",
              sandbox: args.sandboxName,
              timestamp: new Date().toISOString(),
              restored_by: "auto_timer",
              policy_snapshot: args.snapshotPath,
              scheduled_restore_at: args.restoreAtIso,
              ...(managedMcpWarning ? { warning: managedMcpWarning } : {}),
            });
            restoreCompleted = true;
            exitCode = 0;
            return "complete";
          }

          // Explicitly ensure state reflects shields are still DOWN.
          // shieldsDown() already wrote shieldsDown: true, but be explicit rather
          // than relying on the absence of an update.
          updateState(args.stateFile, { shieldsDown: true });
          appendAudit({
            action: "shields_up_failed",
            sandbox: args.sandboxName,
            timestamp: new Date().toISOString(),
            restored_by: "auto_timer",
            error: "Config re-lock verification failed — shields remain DOWN",
          });
          exitCode = 1;
          return "retry";
        },
        {
          takeoverToken: args.processToken,
          recoverStaleOwner: false,
          waitTimeoutMs: 0,
        },
      );
    const restoreWhileDeadlineOwned = async (): Promise<void> => {
      for (;;) {
        const attempt = (recoveryBudget.attemptsUsed += 1);
        let outcome: RestoreAttemptOutcome;
        try {
          shields.prepareAutoRestoreTransitionTakeover(
            args.sandboxName,
            args.processToken!,
            args.snapshotPath,
            assertTakeoverAuthority,
          );
          outcome = restoreUnderDeadlineFence();
        } catch (error) {
          const lockPath = getMcpLifecycleLockPath(args.sandboxName, STATE_DIR);
          if (isDurableContainmentFailure(error) || fs.existsSync(`${lockPath}.containment`)) {
            terminalContainment = true;
            throw durableMcpLifecycleContainmentFailure(error, lockPath);
          }
          appendAudit({
            action: "shields_up_failed",
            sandbox: args.sandboxName,
            timestamp: new Date().toISOString(),
            restored_by: "auto_timer",
            policy_snapshot: args.snapshotPath,
            error: error instanceof Error ? error.message : String(error),
          });
          exitCode = 1;
          outcome = "retry";
        }
        if (outcome !== "retry") return;
        if (!markerMatchesCurrentTimer(args)) return;
        if (attempt >= maxRestoreAttempts) {
          terminalContainment = true;
          throw terminalRecoveryFailure(attempt);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        if (!markerMatchesCurrentTimer(args)) return;
      }
    };
    await withMcpLifecycleDeadlineFence(
      args.sandboxName,
      args.processToken,
      restoreWhileDeadlineOwned,
      {
        stateDir: STATE_DIR,
        pollIntervalMs: 50,
        timeoutMs: deadlineSetupTimeoutMs,
        throwOnCommittedContainment: true,
        onSetupFailure: async () => {
          const attempt = (recoveryBudget.attemptsUsed += 1);
          if (attempt >= maxRestoreAttempts) throw terminalRecoveryFailure(attempt);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          assertTakeoverAuthority();
        },
        onContainment: ({ kind, ownerPid, reason }) => {
          if (kind === "verified-live-wait") {
            appendAudit({
              action: "shields_auto_restore_lock_warning",
              sandbox: args.sandboxName,
              timestamp: new Date().toISOString(),
              restored_by: "auto_timer",
              policy_snapshot: args.snapshotPath,
              warning: reason,
            });
            return;
          }
          appendAudit({
            action: "shields_up_failed",
            sandbox: args.sandboxName,
            timestamp: new Date().toISOString(),
            restored_by: "auto_timer",
            policy_snapshot: args.snapshotPath,
            error: `${reason}${ownerPid ? ` Contained owner PID: ${String(ownerPid)}.` : ""}`,
          });
        },
        onReleased: () => {
          // Retire timer authority only after both exact lifecycle generations
          // are gone, without yielding another event-loop turn in between.
          if (restoreCompleted) cleanupOwnedTimerMarker(args);
        },
      },
    );
  } catch (error: unknown) {
    let reportedError = error;
    if (isDurableContainmentFailure(reportedError)) {
      terminalContainment = true;
    } else if (markerMatchesCurrentTimer(args)) {
      if (recoveryBudget.attemptsUsed === attemptsAtEntry) {
        recoveryBudget.attemptsUsed += 1;
      }
      if (recoveryBudget.attemptsUsed >= maxRestoreAttempts) {
        reportedError = terminalRecoveryFailure(recoveryBudget.attemptsUsed);
        terminalContainment = isDurableContainmentFailure(reportedError);
      }
    }
    appendAudit({
      action: "shields_up_failed",
      sandbox: args.sandboxName,
      timestamp: new Date().toISOString(),
      restored_by: "auto_timer",
      error: reportedError instanceof Error ? reportedError.message : String(reportedError),
    });
    exitCode = 1;
    if (!terminalContainment && recoveryBudget.attemptsUsed < maxRestoreAttempts) scheduleRetry();
  } finally {
    if (!retryScheduled) process.exit(exitCode);
  }
}

async function runRestoreTimer(
  args: TimerArgs,
  runtimeOptions: TimerRuntimeOptions = {},
): Promise<void> {
  return await runRestoreTimerWithBudget(args, runtimeOptions, { attemptsUsed: 0 });
}

function main(): void {
  const args = parseTimerArgs(process.argv.slice(2));
  if (!args) {
    process.exit(1);
  }

  let scheduled = false;
  const authorize = (): boolean => {
    if (scheduled) return true;
    const marker = readTimerMarker(args.markerPath);
    if (!markerRecordMatchesCurrentTimer(marker, args)) return false;
    const restoreTimeout = setTimeout(
      () => {
        clearInterval(authorityPoll);
        const currentMarker = readTimerMarker(args.markerPath);
        if (
          !markerRecordMatchesCurrentTimer(currentMarker, args) ||
          !hasExactTimerAuthorizationProof(currentMarker!)
        ) {
          process.exit(0);
          return;
        }
        void runRestoreTimer(args);
      },
      Math.max(0, args.restoreAtMs - Date.now()),
    );
    const authorityPoll = setInterval(() => {
      const currentMarker = readTimerMarker(args.markerPath);
      if (
        markerRecordMatchesCurrentTimer(currentMarker, args) &&
        hasExactTimerAuthorizationProof(currentMarker!)
      ) {
        return;
      }
      clearTimeout(restoreTimeout);
      clearInterval(authorityPoll);
      process.exit(0);
    }, AUTO_RESTORE_AUTHORITY_POLL_MS);
    scheduled = true;
    try {
      writeTimerAuthorizationProofForMarker(marker!);
      if (!hasExactTimerAuthorizationProof(marker!)) {
        throw new Error("Timer authorization proof did not verify after publication");
      }
    } catch {
      clearTimeout(restoreTimeout);
      clearInterval(authorityPoll);
      scheduled = false;
      return false;
    }
    return true;
  };

  // The parent publishes the PID/token marker before authorizing this child.
  // Without this barrier a short timeout can fire in the fork-to-marker gap,
  // causing the child to exit before the parent records a now-dead timer PID.
  process.on("message", (message: unknown) => {
    const request = message as {
      type?: unknown;
      processToken?: unknown;
      acknowledge?: unknown;
    };
    if (
      typeof message === "object" &&
      message !== null &&
      request.type === "authorize" &&
      request.processToken === args.processToken
    ) {
      const authorized = authorize();
      if (!authorized) {
        process.exit(1);
        return;
      }
      if (request.acknowledge === true && process.connected && process.send !== undefined) {
        process.send({ type: "authorized", processToken: args.processToken }, () => undefined);
      }
    }
  });
  process.once("disconnect", () => {
    if (!authorize()) process.exit(1);
  });
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
