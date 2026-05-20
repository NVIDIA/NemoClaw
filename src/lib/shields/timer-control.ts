// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveNemoclawStateDir } from "../state/paths";

interface TimerMarker {
  pid: number;
  sandboxName: string;
  snapshotPath: string;
  restoreAt: string;
  processToken?: string;
}

type UnknownRecord = { [key: string]: unknown };

function isObjectRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimerMarker(value: unknown): value is TimerMarker {
  const pid = isObjectRecord(value) ? value.pid : undefined;
  return (
    isObjectRecord(value) &&
    typeof pid === "number" &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof value.sandboxName === "string" &&
    typeof value.snapshotPath === "string" &&
    typeof value.restoreAt === "string" &&
    (value.processToken === undefined || typeof value.processToken === "string")
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readProcessCommandLine(pid: number): string | null {
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
    const psCommand = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return psCommand || null;
  } catch {
    return null;
  }
}

function verifyTimerMarkerIdentity(
  marker: TimerMarker,
): { verified: boolean; warning?: string } {
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

export {
  timerMarkerPath,
  readTimerMarker,
  clearTimerMarker,
  isProcessAlive,
  verifyTimerMarkerIdentity,
  killTimer,
};

export type {
  TimerMarker,
  ClearTimerMarkerResult,
  KillTimerResult,
};
