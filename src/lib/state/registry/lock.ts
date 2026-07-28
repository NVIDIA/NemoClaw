// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isErrnoException } from "../../core/errno";
import { ensureConfigDir } from "../config-io";
import { REGISTRY_FILE } from "./persistence";

export const LOCK_DIR = `${REGISTRY_FILE}.lock`;
export const LOCK_OWNER = path.join(LOCK_DIR, "owner");
export const LOCK_STALE_MS = 10_000;
export const LOCK_RETRY_MS = 100;
export const LOCK_MAX_RETRIES = 120;
/** kill(pid, 0) liveness probe. EPERM means the pid exists but is owned by
 * another user, which still counts as alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/** Wall-clock start time (ms since epoch) of `pid` from /proc, or null when it
 * cannot be read (process gone, or a non-Linux host without /proc). Mirrors the
 * onboard-session lock's recycle check. */
function readProcessStartMs(pid: number): number | null {
  try {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const btimeLine = fs
      .readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((line) => line.startsWith("btime "));
    const bootSeconds = btimeLine ? Number(btimeLine.trim().split(/\s+/)[1]) : NaN;
    const closeParen = statText.lastIndexOf(")");
    if (!Number.isFinite(bootSeconds) || closeParen < 0) return null;
    const fieldsAfterComm = statText
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = Number(fieldsAfterComm[19]);
    if (!Number.isFinite(startTicks)) return null;
    // /proc/<pid>/stat starttime is in USER_HZ ticks (100 on supported hosts).
    const clockTicksPerSecond = 100;
    return (bootSeconds + startTicks / clockTicksPerSecond) * 1000;
  } catch {
    return null;
  }
}

export type RegistryLockDecision = "break" | "wait";

/**
 * Decide whether an existing registry lock should be broken (stale) or waited
 * on. Exported for tests.
 *
 * The PID-recycle wedge this guards against: a holder that crashes without
 * releasing leaves `LOCK_DIR` + the owner pid behind. If that pid is later
 * reused by an unrelated live process, `kill(pid, 0)` succeeds, so a
 * liveness-only check treats the lock as held forever and every registry write
 * wedges (retries exhausted -> "Failed to acquire lock"). When the owner looks
 * alive we therefore also confirm it started BEFORE it took the lock: a process
 * whose /proc start time is after the lock's mtime is a recycled pid, so the
 * lock is stale. When the owner pid or its start time cannot be read (missing
 * owner file, non-Linux host), fall back to breaking the lock once it is older
 * than a registry op could legitimately take.
 */
export function classifyExistingLock(opts: {
  ownerPid: number | null;
  ownerAlive: boolean;
  processStartMs: number | null;
  lockMtimeMs: number;
  nowMs: number;
  staleMs: number;
}): RegistryLockDecision {
  const ageMs = opts.nowMs - opts.lockMtimeMs;
  if (opts.ownerPid === null) {
    // Owner file missing or unreadable: decide on age alone.
    return ageMs > opts.staleMs ? "break" : "wait";
  }
  if (!opts.ownerAlive) {
    return "break";
  }
  if (opts.processStartMs !== null && opts.processStartMs > opts.lockMtimeMs + 1000) {
    // Live pid that started after the lock was taken -> the pid was recycled.
    return "break";
  }
  // Live original holder (or start time unknown): only break once the lock is
  // clearly older than a registry op could take, which also covers hosts where
  // recycle cannot be detected directly.
  return ageMs > opts.staleMs ? "break" : "wait";
}

/** Acquire an advisory lock using mkdir (atomic on POSIX). */
export function acquireLock(): void {
  ensureConfigDir(path.dirname(REGISTRY_FILE));
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      const ownerTmp = `${LOCK_OWNER}.tmp.${process.pid}`;
      try {
        fs.writeFileSync(ownerTmp, String(process.pid), { mode: 0o600 });
        fs.renameSync(ownerTmp, LOCK_OWNER);
      } catch (ownerErr) {
        try {
          fs.unlinkSync(ownerTmp);
        } catch {
          /* best effort */
        }
        try {
          fs.unlinkSync(LOCK_OWNER);
        } catch {
          /* best effort */
        }
        try {
          fs.rmdirSync(LOCK_DIR);
        } catch {
          /* best effort */
        }
        throw ownerErr;
      }
      return;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }
      let lockStat: fs.Stats;
      try {
        lockStat = fs.statSync(LOCK_DIR);
      } catch {
        // Lock dir vanished between the failed mkdir and this stat: another
        // waiter released it, so retry immediately.
        continue;
      }
      let ownerPid: number | null = null;
      try {
        const parsed = Number.parseInt(fs.readFileSync(LOCK_OWNER, "utf-8").trim(), 10);
        ownerPid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      } catch {
        ownerPid = null;
      }
      const ownerAlive = ownerPid !== null ? isProcessAlive(ownerPid) : false;
      const processStartMs = ownerPid !== null && ownerAlive ? readProcessStartMs(ownerPid) : null;
      const decision = classifyExistingLock({
        ownerPid,
        ownerAlive,
        processStartMs,
        lockMtimeMs: lockStat.mtimeMs,
        nowMs: Date.now(),
        staleMs: LOCK_STALE_MS,
      });
      if (decision === "break") {
        // Only break the lock if it is provably the same one we classified.
        // Re-stat LOCK_DIR and require the inode + mtime to be unchanged (a
        // replacement lock is a fresh mkdir, hence a new inode) and, when the
        // owner pid was readable, that it still matches. Any stat/read failure
        // means the identity cannot be proven, so the lock is left alone rather
        // than risk clobbering an in-flight replacement that exists as LOCK_DIR
        // before its owner file has been written.
        let stillSameLock = false;
        try {
          const currentStat = fs.statSync(LOCK_DIR);
          stillSameLock =
            currentStat.ino === lockStat.ino && currentStat.mtimeMs === lockStat.mtimeMs;
          if (stillSameLock && ownerPid !== null) {
            const recheck = Number.parseInt(fs.readFileSync(LOCK_OWNER, "utf-8").trim(), 10);
            stillSameLock = recheck === ownerPid;
          }
        } catch {
          stillSameLock = false;
        }
        if (stillSameLock) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      }
      Atomics.wait(sleepBuf, 0, 0, LOCK_RETRY_MS);
    }
  }
  throw new Error(`Failed to acquire lock on ${REGISTRY_FILE} after ${LOCK_MAX_RETRIES} retries`);
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_OWNER);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

export function withLock<T>(fn: () => T): T {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}
