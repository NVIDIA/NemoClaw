// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { isErrnoException } from "../../core/errno";

export interface OnboardLockHolderIdentity {
  readonly pid: number;
  readonly startedAt: string | null;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function readProcProcessStartMs(pid: number): number | null {
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

    // Linux exposes /proc/<pid>/stat starttime in USER_HZ ticks. 100 is the
    // stable value on supported NemoClaw Linux hosts.
    const clockTicksPerSecond = 100;
    return (bootSeconds + startTicks / clockTicksPerSecond) * 1000;
  } catch {
    return null;
  }
}

/**
 * Confirm that a live PID still names the process that wrote an onboarding
 * lock. Linux process start metadata distinguishes a reused PID; platforms
 * without that metadata stay fail-closed and continue to treat it as held.
 */
export function onboardLockHolderStillMatches(lock: OnboardLockHolderIdentity): boolean {
  if (!isProcessAlive(lock.pid)) return false;
  if (lock.pid === process.pid) return true;

  const lockStartedMs = lock.startedAt ? Date.parse(lock.startedAt) : NaN;
  if (!Number.isFinite(lockStartedMs)) return true;

  const processStartMs = readProcProcessStartMs(lock.pid);
  if (processStartMs === null) return true;

  // The original lock holder must have started before it wrote the lock. If
  // the currently-live PID started after the lock timestamp, the PID was reused
  // and the lock is stale even though kill(pid, 0) succeeds.
  return processStartMs <= lockStartedMs + 1000;
}
