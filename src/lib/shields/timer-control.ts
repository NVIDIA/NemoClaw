// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { isObjectRecord } from "../core/json-types";
import { resolveNemoclawStateDir } from "../state/paths";

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

interface TimerMarker {
  pid: number;
  sandboxName: string;
  snapshotPath: string;
  restoreAt: string;
  processToken?: string;
  allowLegacyHermesProtocol?: boolean;
  leaseOwnerPid?: number;
  leaseOwnerStartIdentity?: string;
}

function isTimerMarker(value: unknown): value is TimerMarker {
  if (!isObjectRecord(value)) return false;
  const pid = value.pid;
  return (
    typeof pid === "number" &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof value.sandboxName === "string" &&
    typeof value.snapshotPath === "string" &&
    typeof value.restoreAt === "string" &&
    (value.processToken === undefined || typeof value.processToken === "string") &&
    (value.allowLegacyHermesProtocol === undefined ||
      typeof value.allowLegacyHermesProtocol === "boolean") &&
    (value.leaseOwnerPid === undefined ||
      (typeof value.leaseOwnerPid === "number" &&
        Number.isInteger(value.leaseOwnerPid) &&
        value.leaseOwnerPid > 0)) &&
    (value.leaseOwnerStartIdentity === undefined ||
      typeof value.leaseOwnerStartIdentity === "string") &&
    ((value.leaseOwnerPid === undefined && value.leaseOwnerStartIdentity === undefined) ||
      (typeof value.leaseOwnerPid === "number" &&
        typeof value.leaseOwnerStartIdentity === "string" &&
        value.leaseOwnerStartIdentity.length > 0))
  );
}

function timerMarkerPath(sandboxName: string): string {
  return path.join(resolveNemoclawStateDir(), `shields-timer-${sandboxName}.json`);
}

function readTimerMarker(sandboxName: string): TimerMarker | null {
  const p = timerMarkerPath(sandboxName);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return isTimerMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readAutoRestoreTakeoverToken(sandboxName: string): string | undefined {
  const marker = readTimerMarker(sandboxName);
  if (
    marker?.sandboxName !== sandboxName ||
    typeof marker.processToken !== "string" ||
    !/^[0-9a-f]{32}$/.test(marker.processToken)
  ) {
    return undefined;
  }
  return marker.processToken;
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

interface ProcessIdentity {
  pid: number;
  startIdentity: string;
  depth: number;
}

function listDescendantProcessIdentities(
  rootPid: number,
  deadline = processInspectionDeadline(),
): ProcessIdentity[] | null {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  let rows: Array<{ pid: number; ppid: number }> = [];
  try {
    const timeout = remainingProcessInspectionTimeout(deadline);
    if (timeout === null) return null;
    rows = execFileSync("ps", ["-e", "-o", "pid=,ppid="], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    })
      .toString()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([pid, ppid]) => ({ pid: Number(pid), ppid: Number(ppid) }))
      .filter((row) => Number.isInteger(row.pid) && Number.isInteger(row.ppid));
  } catch {
    return null;
  }

  const descendants: Array<{ pid: number; depth: number }> = [];
  let frontier = [{ pid: rootPid, depth: 0 }];
  const seen = new Set<number>([rootPid]);
  while (frontier.length > 0) {
    const next: Array<{ pid: number; depth: number }> = [];
    for (const parent of frontier) {
      for (const row of rows) {
        if (row.ppid !== parent.pid || seen.has(row.pid)) continue;
        seen.add(row.pid);
        const child = { pid: row.pid, depth: parent.depth + 1 };
        descendants.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }

  const identities: ProcessIdentity[] = [];
  for (const { pid, depth } of descendants) {
    const startIdentity = readProcessStartIdentity(pid, deadline);
    if (startIdentity) {
      identities.push({ pid, startIdentity, depth });
    } else if (isProcessAlive(pid, deadline)) {
      // A live descendant that cannot be identity-pinned must not be signaled;
      // callers fail closed instead of risking PID-reuse collateral damage.
      return null;
    }
  }
  return identities.sort((a, b) => b.depth - a.depth);
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

function verifyTimerMarkerIdentity(marker: TimerMarker): { verified: boolean; warning?: string } {
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
  let terminated = false;
  const warnings: string[] = [];

  if (marker) {
    wasAlive = isProcessAlive(marker.pid);
    if (wasAlive) {
      const verification = verifyTimerMarkerIdentity(marker);
      if (!verification.verified) {
        if (verification.warning) {
          warnings.push(verification.warning);
        }
      } else {
        try {
          process.kill(marker.pid, "SIGTERM");
          terminated = true;
        } catch (error) {
          const errno = error as NodeJS.ErrnoException;
          if (errno.code !== "ESRCH") {
            warnings.push(
              `Failed to terminate shields timer PID ${String(marker.pid)} for sandbox '${sandboxName}': ${errno.message}`,
            );
          }
        }
      }
    }
  }

  const markerClear = clearTimerMarker(sandboxName);
  if (markerClear.warning) {
    warnings.push(markerClear.warning);
  }

  return {
    markerFound: marker !== null,
    markerPid: marker?.pid ?? null,
    wasAlive,
    terminated,
    warnings,
  };
}

export type { ClearTimerMarkerResult, KillTimerResult, ProcessIdentity, TimerMarker };
export {
  clearTimerMarker,
  isProcessAlive,
  killTimer,
  listDescendantProcessIdentities,
  processInspectionDeadlineAfter,
  processInspectionDeadlineReached,
  readAutoRestoreTakeoverToken,
  readProcessStartIdentity,
  readProcessState,
  readTimerMarker,
  timerMarkerPath,
  verifyTimerMarkerIdentity,
};
