// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { isObjectRecord } from "../../core/json-types";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../name-validation";
import { processIsAlive } from "../mcp-lifecycle-lock-identity";
import { resolveNemoclawStateDir } from "../paths";

export interface ShieldsTimerMarker {
  pid: number;
  sandboxName: string;
  snapshotPath: string;
  restoreAt: string;
  processToken?: string;
  timerProcessStartIdentity?: string;
  allowLegacyHermesProtocol?: boolean;
  agentName?: string;
  configPath?: string;
  configDir?: string;
  leaseOwnerPid?: number;
  leaseOwnerStartIdentity?: string;
}

function isShieldsTimerMarker(value: unknown): value is ShieldsTimerMarker {
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
    (value.timerProcessStartIdentity === undefined ||
      (typeof value.timerProcessStartIdentity === "string" &&
        value.timerProcessStartIdentity.length > 0)) &&
    (value.allowLegacyHermesProtocol === undefined ||
      typeof value.allowLegacyHermesProtocol === "boolean") &&
    (value.agentName === undefined || typeof value.agentName === "string") &&
    (value.configPath === undefined || typeof value.configPath === "string") &&
    (value.configDir === undefined || typeof value.configDir === "string") &&
    ((value.configPath === undefined && value.configDir === undefined) ||
      (typeof value.configPath === "string" && typeof value.configDir === "string")) &&
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

export function shieldsTimerMarkerPath(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): string {
  if (
    sandboxName.length === 0 ||
    sandboxName.length > NAME_MAX_LENGTH ||
    !NAME_VALID_PATTERN.test(sandboxName)
  ) {
    throw new Error("Cannot resolve a Shields timer marker for an invalid sandbox name");
  }
  return path.join(stateDir, `shields-timer-${sandboxName}.json`);
}

export function readShieldsTimerMarker(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): ShieldsTimerMarker | null {
  try {
    const marker = readShieldsTimerMarkerFile(shieldsTimerMarkerPath(sandboxName, stateDir));
    return marker?.sandboxName === sandboxName ? marker : null;
  } catch {
    return null;
  }
}

export function readShieldsTimerMarkerFile(markerPath: string): ShieldsTimerMarker | null {
  try {
    const markerFd = fs.openSync(
      markerPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      if (!fs.fstatSync(markerFd).isFile()) return null;
      const parsed = JSON.parse(fs.readFileSync(markerFd, "utf-8"));
      return isShieldsTimerMarker(parsed) ? parsed : null;
    } finally {
      fs.closeSync(markerFd);
    }
  } catch {
    return null;
  }
}

export function readShieldsTimerTakeoverToken(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): string | undefined {
  const marker = readShieldsTimerMarker(sandboxName, stateDir);
  if (
    marker?.sandboxName !== sandboxName ||
    typeof marker.processToken !== "string" ||
    !/^[0-9a-f]{32}$/.test(marker.processToken)
  ) {
    return undefined;
  }
  return marker.processToken;
}

export function isShieldsTimerDeadlineExpired(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
  now = Date.now(),
): boolean {
  const marker = readShieldsTimerMarker(sandboxName, stateDir);
  if (
    marker?.sandboxName !== sandboxName ||
    typeof marker.processToken !== "string" ||
    !/^[0-9a-f]{32}$/.test(marker.processToken)
  ) {
    return false;
  }
  const restoreAtMs = new Date(marker.restoreAt).getTime();
  return Number.isFinite(restoreAtMs) && restoreAtMs <= now;
}

/** Liveness evidence stays injectable so gate tests need no real timer process. */
export interface ShieldsTimerLivenessProbes {
  processIsAlive(pid: number): boolean;
  /**
   * Optional override for tests. Production uses `/proc/<pid>/stat` starttime
   * (`proc:<ticks>`), the same prefix the Linux timer marker stores.
   */
  readProcessStartIdentity?(pid: number): string | null;
}

function readLinuxTimerProcessStartIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const closingParen = raw.lastIndexOf(")");
    if (closingParen < 0) return null;
    const fields = raw
      .slice(closingParen + 2)
      .trim()
      .split(/\s+/);
    return fields[19] ? `proc:${fields[19]}` : null;
  } catch {
    return null;
  }
}

const LOCAL_TIMER_LIVENESS_PROBES: ShieldsTimerLivenessProbes = {
  processIsAlive,
  readProcessStartIdentity: readLinuxTimerProcessStartIdentity,
};

/**
 * Ordinary acquisition waits for an expired 32-hex marker because a live timer
 * still has to publish the deadline fence. That wait is abandoned only when
 * this process can no longer be the timer: `kill(pid, 0)` fails, or a recorded
 * start identity no longer matches. A live PID with no readable start identity
 * stays closed. This function does not invent a start identity; missing
 * `timerProcessStartIdentity` falls back to the PID check only.
 */
export function isShieldsTimerDeadlineAbandoned(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
  now = Date.now(),
  probes: ShieldsTimerLivenessProbes = LOCAL_TIMER_LIVENESS_PROBES,
): boolean {
  if (!isShieldsTimerDeadlineExpired(sandboxName, stateDir, now)) return false;
  const marker = readShieldsTimerMarker(sandboxName, stateDir);
  if (!marker) return false;
  const recorded = marker.timerProcessStartIdentity;
  if (typeof recorded === "string" && recorded.length > 0) {
    const observed =
      probes.readProcessStartIdentity?.(marker.pid) ??
      readLinuxTimerProcessStartIdentity(marker.pid);
    if (observed !== null && observed !== recorded) return true;
    if (observed === null && probes.processIsAlive(marker.pid)) return false;
  }
  return !probes.processIsAlive(marker.pid);
}
