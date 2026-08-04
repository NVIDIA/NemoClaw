// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

import {
  readShieldsTimerMarker,
  readShieldsTimerTakeoverToken,
  type ShieldsTimerMarker,
  shieldsTimerMarkerPath,
} from "../state/mcp-lifecycle-lock/shields-timer-authority";

const DEFAULT_PROCESS_INSPECTION_TIMEOUT_MS = 5_000;

function processInspectionDeadline(deadline?: number): number {
  return deadline ?? processInspectionDeadlineAfter(DEFAULT_PROCESS_INSPECTION_TIMEOUT_MS);
}

function remainingProcessInspectionTimeout(deadline: number): number | null {
  const remaining = deadline - performance.now();
  return remaining > 0 ? Math.max(1, Math.floor(remaining)) : null;
}

function processInspectionDeadlineAfter(timeoutMs: number): number {
  return performance.now() + timeoutMs;
}

function processInspectionDeadlineReached(deadline: number): boolean {
  return performance.now() >= deadline;
}

function timerMarkerPath(sandboxName: string): string {
  return shieldsTimerMarkerPath(sandboxName);
}

function readTimerMarker(sandboxName: string): ShieldsTimerMarker | null {
  return readShieldsTimerMarker(sandboxName);
}

function readAutoRestoreTakeoverToken(sandboxName: string): string | undefined {
  return readShieldsTimerTakeoverToken(sandboxName);
}

interface ClearTimerMarkerResult {
  cleared: boolean;
  warning?: string;
}

function clearTimerMarker(sandboxName: string): ClearTimerMarkerResult {
  const markerPath = timerMarkerPath(sandboxName);
  try {
    fs.unlinkSync(markerPath);
    return { cleared: true };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return { cleared: false };
    }
    return {
      cleared: false,
      warning: `Failed to remove shields timer marker '${markerPath}': ${errno.message}`,
    };
  }
}

function readProcessState(pid: number, deadline = processInspectionDeadline()): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (remainingProcessInspectionTimeout(deadline) === null) return null;
  try {
    const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const closingParen = raw.lastIndexOf(")");
    if (closingParen >= 0) {
      const state = raw
        .slice(closingParen + 2)
        .trim()
        .split(/\s+/, 1)[0];
      if (state) return state;
    }
  } catch {
    // Fall through to the portable ps state.
  }
  try {
    const timeout = remainingProcessInspectionTimeout(deadline);
    if (timeout === null) return null;
    return (
      execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout,
      })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number, deadline = processInspectionDeadline()): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (readProcessState(pid, deadline)?.startsWith("Z")) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readProcessStartIdentity(
  pid: number,
  deadline = processInspectionDeadline(),
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (remainingProcessInspectionTimeout(deadline) === null) return null;
  try {
    const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const closingParen = raw.lastIndexOf(")");
    if (closingParen >= 0) {
      const fields = raw
        .slice(closingParen + 2)
        .trim()
        .split(/\s+/);
      // The suffix starts at field 3 (`state`); Linux starttime is field 22.
      if (fields[19]) return `proc:${fields[19]}`;
    }
  } catch {
    // Fall through to the portable ps identity.
  }

  try {
    const timeout = remainingProcessInspectionTimeout(deadline);
    if (timeout === null) return null;
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    })
      .toString()
      .trim();
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

function readProcessCommandLine(
  pid: number,
  deadline = processInspectionDeadline(),
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (remainingProcessInspectionTimeout(deadline) === null) return null;
  const procCmdline = `/proc/${String(pid)}/cmdline`;
  try {
    if (fs.existsSync(procCmdline)) {
      const cmdline = fs.readFileSync(procCmdline, "utf-8").replaceAll("\0", " ").trim();
      return cmdline || null;
    }
  } catch {
    // Fall through to ps-based lookup.
  }

  try {
    const timeout = remainingProcessInspectionTimeout(deadline);
    if (timeout === null) return null;
    const psCommand = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    })
      .toString()
      .trim();
    return psCommand || null;
  } catch {
    return null;
  }
}

function verifyTimerMarkerIdentity(marker: ShieldsTimerMarker): {
  verified: boolean;
  warning?: string;
} {
  const commandLine = readProcessCommandLine(marker.pid);
  if (!commandLine) {
    return {
      verified: false,
      warning: `Unable to verify shields timer PID ${String(marker.pid)} for sandbox '${marker.sandboxName}'; clearing marker without signaling.`,
    };
  }

  const looksLikeTimerProcess =
    commandLine.includes("shields/timer.js") || commandLine.includes("shields/timer.ts");
  const hasSandboxArg = commandLine.includes(marker.sandboxName);

  if (!looksLikeTimerProcess || !hasSandboxArg) {
    return {
      verified: false,
      warning: `PID ${String(marker.pid)} does not match shields timer identity for sandbox '${marker.sandboxName}'; clearing marker without signaling.`,
    };
  }

  if (marker.processToken && !commandLine.includes(marker.processToken)) {
    return {
      verified: false,
      warning: `PID ${String(marker.pid)} token mismatch for sandbox '${marker.sandboxName}'; clearing marker without signaling.`,
    };
  }

  return { verified: true };
}

interface KillTimerResult {
  markerFound: boolean;
  markerPid: number | null;
  wasAlive: boolean;
  terminated: boolean;
  warnings: string[];
}

function killTimer(sandboxName: string): KillTimerResult {
  const marker = readTimerMarker(sandboxName);
  let wasAlive = false;
  const warnings: string[] = [];

  if (marker) {
    wasAlive = isProcessAlive(marker.pid);
    if (wasAlive) {
      const verification = verifyTimerMarkerIdentity(marker);
      if (!verification.verified) {
        if (verification.warning) {
          warnings.push(verification.warning);
        }
      }
    }
  }

  // Marker removal is cooperative cancellation and revokes the timer's exact
  // recovery generation. Do not signal a verified live timer: it may own the
  // lifecycle deadline fence, and an unhandled signal could bypass its finally
  // cleanup and strand the fence. Recovery loops re-check marker authority and
  // unwind their locks after this revocation.
  const markerClear = clearTimerMarker(sandboxName);
  if (markerClear.warning) {
    warnings.push(markerClear.warning);
  }

  return {
    markerFound: marker !== null,
    markerPid: marker?.pid ?? null,
    wasAlive,
    terminated: false,
    warnings,
  };
}

export type { ClearTimerMarkerResult, KillTimerResult, ShieldsTimerMarker as TimerMarker };
export {
  clearTimerMarker,
  isProcessAlive,
  killTimer,
  processInspectionDeadlineAfter,
  processInspectionDeadlineReached,
  readAutoRestoreTakeoverToken,
  readProcessStartIdentity,
  readProcessState,
  readTimerMarker,
  timerMarkerPath,
  verifyTimerMarkerIdentity,
};
