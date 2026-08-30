// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { isObjectRecord } from "../../core/json-types";
import { isValidName, NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../name-validation";
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

export interface ShieldsTimerRecoveryCandidate {
  artifactPaths: string[];
  marker: ShieldsTimerMarker;
  quarantined: boolean;
}

const MAX_SHIELDS_TIMER_MARKER_BYTES = 64 * 1024;

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
    const markerFile = openRegularFileNoFollow(markerPath);
    try {
      const parsed = JSON.parse(
        markerFile.readBytes(MAX_SHIELDS_TIMER_MARKER_BYTES).toString("utf-8"),
      );
      return isShieldsTimerMarker(parsed) ? parsed : null;
    } finally {
      markerFile.close();
    }
  } catch {
    return null;
  }
}

function completedTimerMarkerPrefix(markerPath: string): string {
  return `${path.basename(markerPath)}.completed-`;
}

export function formatTerminalSafeDiagnosticValue(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

function timerRecoveryArtifactInspectionError(
  sandboxName: string,
  stateDir: string,
  error: unknown,
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Automatic Shields timer recovery could not inspect artifacts for sandbox '${sandboxName}' in state directory ${formatTerminalSafeDiagnosticValue(stateDir)}: ${formatTerminalSafeDiagnosticValue(detail)}. Correct the state-directory access failure, then rerun Shields status.`,
    { cause: error },
  );
}

export function sameShieldsTimerMarkerGeneration(
  current: ShieldsTimerMarker | null,
  expected: ShieldsTimerMarker,
): boolean {
  return (
    current?.pid === expected.pid &&
    current.sandboxName === expected.sandboxName &&
    current.snapshotPath === expected.snapshotPath &&
    current.restoreAt === expected.restoreAt &&
    current.processToken === expected.processToken &&
    current.timerProcessStartIdentity === expected.timerProcessStartIdentity &&
    current.allowLegacyHermesProtocol === expected.allowLegacyHermesProtocol &&
    current.agentName === expected.agentName &&
    current.configPath === expected.configPath &&
    current.configDir === expected.configDir &&
    current.leaseOwnerPid === expected.leaseOwnerPid &&
    current.leaseOwnerStartIdentity === expected.leaseOwnerStartIdentity
  );
}

function ambiguousRecoveryArtifactsError(
  sandboxName: string,
  stateDir: string,
  artifactPaths: readonly string[],
): Error {
  return new Error(
    `Automatic Shields timer recovery stopped for sandbox '${sandboxName}' in state directory ${formatTerminalSafeDiagnosticValue(stateDir)} because its recovery artifacts are invalid or represent different generations. Stop all NemoClaw processes for this sandbox. Inspect each artifact and record its PID, process token, restore deadline, snapshot path, and process-start identity: ${artifactPaths.map(formatTerminalSafeDiagnosticValue).join(", ")}. Remove only an artifact whose exact process generation is proven obsolete, then rerun Shields status.`,
  );
}

export function hasShieldsTimerRecoveryArtifact(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): boolean {
  if (!isValidName(sandboxName)) return false;
  try {
    const markerPath = shieldsTimerMarkerPath(sandboxName, stateDir);
    if (fs.existsSync(markerPath)) return true;
    return hasQuarantinedShieldsTimerRecoveryArtifact(sandboxName, stateDir);
  } catch {
    // Route an unreadable state directory through the detailed recovery path.
    return true;
  }
}

export function hasQuarantinedShieldsTimerRecoveryArtifact(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): boolean {
  try {
    const markerPath = shieldsTimerMarkerPath(sandboxName, stateDir);
    const prefix = completedTimerMarkerPrefix(markerPath);
    return fs.readdirSync(path.dirname(markerPath)).some((name) => name.startsWith(prefix));
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return false;
    throw timerRecoveryArtifactInspectionError(sandboxName, stateDir, error);
  }
}

export function readShieldsTimerRecoveryCandidate(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): ShieldsTimerRecoveryCandidate | null {
  const markerPath = shieldsTimerMarkerPath(sandboxName, stateDir);
  const prefix = completedTimerMarkerPrefix(markerPath);
  let quarantinePaths: string[];
  try {
    quarantinePaths = fs
      .readdirSync(path.dirname(markerPath))
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(path.dirname(markerPath), name))
      .sort();
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") {
      throw timerRecoveryArtifactInspectionError(sandboxName, stateDir, error);
    }
    quarantinePaths = [];
  }
  const candidates = [...(fs.existsSync(markerPath) ? [markerPath] : []), ...quarantinePaths];
  if (candidates.length === 0) return null;
  const markers = candidates.map((candidatePath) => readShieldsTimerMarkerFile(candidatePath));
  const marker = markers[0];
  if (
    !marker ||
    marker.sandboxName !== sandboxName ||
    markers.some(
      (candidate) =>
        candidate?.sandboxName !== sandboxName ||
        !sameShieldsTimerMarkerGeneration(candidate, marker),
    )
  ) {
    throw ambiguousRecoveryArtifactsError(sandboxName, stateDir, candidates);
  }
  const candidatePath = candidates[0];
  return {
    artifactPaths: candidates,
    marker,
    quarantined: candidatePath !== markerPath,
  };
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
   * Optional override for tests. Production uses the same `proc:` / `ps:`
   * reader as Shields timer control.
   */
  readProcessStartIdentity?(pid: number): string | null;
}

const DEFAULT_TIMER_IDENTITY_TIMEOUT_MS = 5_000;

/**
 * Read the same start identity Shields timer control records: Linux
 * `/proc/<pid>/stat` starttime as `proc:<ticks>`, then `ps -o lstart=` as
 * `ps:<start-time>` when `/proc` is unavailable.
 */
export function readTimerProcessStartIdentity(
  pid: number,
  timeoutMs = DEFAULT_TIMER_IDENTITY_TIMEOUT_MS,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const closingParen = raw.lastIndexOf(")");
    if (closingParen >= 0) {
      const fields = raw
        .slice(closingParen + 2)
        .trim()
        .split(/\s+/);
      if (fields[19]) return `proc:${fields[19]}`;
    }
  } catch {
    // Fall through to the portable ps identity.
  }
  try {
    const timeout = Math.max(1, Math.floor(timeoutMs));
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

export const localTimerProcessStartIdentity = {
  read: readTimerProcessStartIdentity,
};

const LOCAL_TIMER_LIVENESS_PROBES: ShieldsTimerLivenessProbes = {
  processIsAlive,
  readProcessStartIdentity: (pid) => localTimerProcessStartIdentity.read(pid),
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
  const marker = readShieldsTimerMarker(sandboxName, stateDir);
  if (!marker) return false;
  return isShieldsTimerMarkerAbandoned(marker, now, probes);
}

export function isShieldsTimerMarkerAbandoned(
  marker: ShieldsTimerMarker,
  now = Date.now(),
  probes: ShieldsTimerLivenessProbes = LOCAL_TIMER_LIVENESS_PROBES,
): boolean {
  if (typeof marker.processToken !== "string" || !/^[0-9a-f]{32}$/.test(marker.processToken)) {
    return false;
  }
  const restoreAtMs = new Date(marker.restoreAt).getTime();
  if (!Number.isFinite(restoreAtMs) || restoreAtMs > now) return false;
  const recorded = marker.timerProcessStartIdentity;
  if (typeof recorded === "string" && recorded.length > 0) {
    const observed = probes.readProcessStartIdentity
      ? probes.readProcessStartIdentity(marker.pid)
      : localTimerProcessStartIdentity.read(marker.pid);
    if (observed !== null && observed !== recorded) return true;
    if (observed === null && probes.processIsAlive(marker.pid)) return false;
  }
  return !probes.processIsAlive(marker.pid);
}
