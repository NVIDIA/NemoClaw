// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { isErrnoException } from "../../core/errno";

export interface ProcessIdentityProbes {
  readonly currentPid: number;
  isAlive(pid: number): boolean;
  readStartedAtMs(pid: number): number | null;
}

let cachedClockTicksPerSecond: number | null | undefined;

function readClockTicksPerSecond(): number | null {
  if (cachedClockTicksPerSecond !== undefined) return cachedClockTicksPerSecond;
  const result = spawnSync("/usr/bin/getconf", ["CLK_TCK"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
  const value = result.status === 0 ? Number(result.stdout.trim()) : NaN;
  cachedClockTicksPerSecond = Number.isFinite(value) && value > 0 ? value : null;
  return cachedClockTicksPerSecond;
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

function readProcessStartedAtMs(pid: number): number | null {
  try {
    const statText = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
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
    const clockTicksPerSecond = readClockTicksPerSecond();
    if (!Number.isFinite(startTicks) || clockTicksPerSecond === null) return null;

    return (bootSeconds + startTicks / clockTicksPerSecond) * 1000;
  } catch {
    return null;
  }
}

/** Real host probes used when state logic does not inject deterministic evidence. */
export const hostProcessIdentityProbes: ProcessIdentityProbes = {
  currentPid: process.pid,
  isAlive: isProcessAlive,
  readStartedAtMs: readProcessStartedAtMs,
};
