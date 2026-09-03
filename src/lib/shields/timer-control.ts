// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import {
  formatTerminalSafeDiagnosticValue,
  hasQuarantinedShieldsTimerRecoveryArtifact,
  isShieldsTimerDeadlineAbandoned,
  isShieldsTimerMarkerAbandoned,
  readShieldsTimerMarker,
  readShieldsTimerMarkerFile,
  readShieldsTimerRecoveryCandidate,
  readShieldsTimerTakeoverToken,
  readTimerProcessStartIdentity,
  sameShieldsTimerMarkerGeneration,
  type ShieldsTimerMarker,
  shieldsTimerMarkerPath,
} from "../state/mcp-lifecycle-lock/shields-timer-authority";

const DEFAULT_PROCESS_INSPECTION_TIMEOUT_MS = 5_000;
const MAX_TIMER_AUTHORIZATION_PROOF_BYTES = 16 * 1024;

interface TimerAuthorizationProof {
  schemaVersion: 1;
  pid: number;
  sandboxName: string;
  processToken: string;
  timerProcessStartIdentity: string;
  authoritySha256: string;
}

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

function timerMarkerPath(sandboxName: string, stateDir?: string): string {
  return shieldsTimerMarkerPath(sandboxName, stateDir);
}

function readTimerMarker(sandboxName: string, stateDir?: string): ShieldsTimerMarker | null {
  return readShieldsTimerMarker(sandboxName, stateDir);
}

function readAutoRestoreTakeoverToken(sandboxName: string): string | undefined {
  return readShieldsTimerTakeoverToken(sandboxName);
}

function timerAuthoritySha256(marker: ShieldsTimerMarker): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        pid: marker.pid,
        sandboxName: marker.sandboxName,
        snapshotPath: marker.snapshotPath,
        restoreAt: marker.restoreAt,
        processToken: marker.processToken ?? null,
        timerProcessStartIdentity: marker.timerProcessStartIdentity ?? null,
        allowLegacyHermesProtocol: marker.allowLegacyHermesProtocol === true,
        agentName: marker.agentName ?? null,
        configPath: marker.configPath ?? null,
        configDir: marker.configDir ?? null,
        leaseOwnerPid: marker.leaseOwnerPid ?? null,
        leaseOwnerStartIdentity: marker.leaseOwnerStartIdentity ?? null,
      }),
    )
    .digest("hex");
}

function timerAuthorizationProofPath(
  sandboxName: string,
  processToken: string,
  stateDir?: string,
): string {
  if (!/^[0-9a-f]{32}$/.test(processToken)) {
    throw new Error("Invalid timer authorization process token");
  }
  return path.join(
    path.dirname(timerMarkerPath(sandboxName, stateDir)),
    `shields-timer-authorization-${sandboxName}-${processToken}.json`,
  );
}

function isTimerAuthorizationProof(value: unknown): value is TimerAuthorizationProof {
  if (typeof value !== "object" || value === null) return false;
  const proof = value as Partial<TimerAuthorizationProof>;
  return (
    proof.schemaVersion === 1 &&
    typeof proof.pid === "number" &&
    Number.isInteger(proof.pid) &&
    proof.pid > 0 &&
    typeof proof.sandboxName === "string" &&
    typeof proof.processToken === "string" &&
    /^[0-9a-f]{32}$/.test(proof.processToken) &&
    typeof proof.timerProcessStartIdentity === "string" &&
    proof.timerProcessStartIdentity.length > 0 &&
    typeof proof.authoritySha256 === "string" &&
    /^[0-9a-f]{64}$/.test(proof.authoritySha256)
  );
}

function writeTimerAuthorizationProofForMarker(marker: ShieldsTimerMarker): void {
  if (!marker.processToken || !marker.timerProcessStartIdentity) {
    throw new Error("Timer marker is missing authorization proof identity");
  }
  const currentStartIdentity = readProcessStartIdentity(process.pid);
  if (marker.pid !== process.pid || currentStartIdentity !== marker.timerProcessStartIdentity) {
    throw new Error("Timer process cannot publish authorization for another process identity");
  }
  const proofPath = timerAuthorizationProofPath(marker.sandboxName, marker.processToken);
  const tempPath = `${proofPath}.${String(process.pid)}.${Date.now().toString(16)}.tmp`;
  const proof: TimerAuthorizationProof = {
    schemaVersion: 1,
    pid: marker.pid,
    sandboxName: marker.sandboxName,
    processToken: marker.processToken,
    timerProcessStartIdentity: marker.timerProcessStartIdentity,
    authoritySha256: timerAuthoritySha256(marker),
  };
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(proofPath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, JSON.stringify(proof));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, proofPath);
    const directoryFd = fs.openSync(path.dirname(proofPath), "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}

function hasExactTimerAuthorizationProof(marker: ShieldsTimerMarker): boolean {
  if (!marker.processToken || !marker.timerProcessStartIdentity) return false;
  let proofFile: ReturnType<typeof openRegularFileNoFollow> | undefined;
  try {
    proofFile = openRegularFileNoFollow(
      timerAuthorizationProofPath(marker.sandboxName, marker.processToken),
    );
    const proofStats = proofFile.stat();
    if (
      (proofStats.mode & 0o777) !== 0o600 ||
      proofStats.size <= 0 ||
      (typeof process.getuid === "function" && proofStats.uid !== process.getuid())
    ) {
      return false;
    }
    const raw = proofFile.readBytes(MAX_TIMER_AUTHORIZATION_PROOF_BYTES).toString("utf-8");
    const proof = JSON.parse(raw) as unknown;
    return (
      isTimerAuthorizationProof(proof) &&
      proof.pid === marker.pid &&
      proof.sandboxName === marker.sandboxName &&
      proof.processToken === marker.processToken &&
      proof.timerProcessStartIdentity === marker.timerProcessStartIdentity &&
      proof.authoritySha256 === timerAuthoritySha256(marker)
    );
  } catch {
    return false;
  } finally {
    proofFile?.close();
  }
}

function removeTimerAuthorizationProof(
  sandboxName: string,
  processToken: string | undefined,
  stateDir?: string,
): void {
  if (!processToken || !/^[0-9a-f]{32}$/.test(processToken)) return;
  try {
    fs.rmSync(timerAuthorizationProofPath(sandboxName, processToken, stateDir), { force: true });
  } catch {
    // Best effort. A proof cannot grant authority without its exact marker.
  }
}

interface ClearTimerMarkerResult {
  warning?: string;
}

interface TimerMarkerRetirementResult {
  status: "removed" | "missing" | "changed" | "failed";
  retainedPath?: string;
  warning?: string;
}

function fsyncTimerArtifactDirectory(artifactPath: string): void {
  const directoryFd = fs.openSync(path.dirname(artifactPath), "r");
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function restoreTimerArtifactAfterDurabilityFailure(
  sourcePath: string,
  expected: ShieldsTimerMarker,
): string | null {
  try {
    fs.writeFileSync(sourcePath, `${JSON.stringify(expected)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const artifactFd = fs.openSync(sourcePath, "r");
    try {
      fs.fsyncSync(artifactFd);
    } finally {
      fs.closeSync(artifactFd);
    }
    fsyncTimerArtifactDirectory(sourcePath);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function clearTimerMarker(sandboxName: string): ClearTimerMarkerResult {
  const marker = readTimerMarker(sandboxName);
  const markerPath = timerMarkerPath(sandboxName);
  try {
    fs.unlinkSync(markerPath);
    removeTimerAuthorizationProof(sandboxName, marker?.processToken);
    const directoryFd = fs.openSync(path.dirname(markerPath), "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    return {};
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return {};
    }
    return {
      warning: `Failed to remove shields timer marker '${markerPath}': ${errno.message}`,
    };
  }
}

const sameTimerMarkerGeneration = sameShieldsTimerMarkerGeneration;

function clearTimerMarkerGeneration(
  sandboxName: string,
  expected: ShieldsTimerMarker,
  stateDir?: string,
  sourcePath = timerMarkerPath(sandboxName, stateDir),
): TimerMarkerRetirementResult {
  const markerPath = timerMarkerPath(sandboxName, stateDir);
  const quarantinePath = `${markerPath}.completed-${String(process.pid)}-${randomUUID()}`;
  try {
    fs.renameSync(sourcePath, quarantinePath);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { status: "missing" };
    return {
      status: "failed",
      warning: `Failed to claim Shields timer recovery artifact ${formatTerminalSafeDiagnosticValue(sourcePath)}: ${formatTerminalSafeDiagnosticValue(errno.message)}`,
    };
  }

  if (sameTimerMarkerGeneration(readShieldsTimerMarkerFile(quarantinePath), expected)) {
    try {
      fs.unlinkSync(quarantinePath);
      removeTimerAuthorizationProof(sandboxName, expected.processToken, stateDir);
      fsyncTimerArtifactDirectory(markerPath);
      return { status: "removed" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!fs.existsSync(quarantinePath)) {
        const restoreFailure = restoreTimerArtifactAfterDurabilityFailure(sourcePath, expected);
        const retainedPath = fs.existsSync(sourcePath) ? sourcePath : undefined;
        return {
          status: "failed",
          ...(retainedPath ? { retainedPath } : {}),
          warning: restoreFailure
            ? `Removed completed Shields timer recovery artifact ${formatTerminalSafeDiagnosticValue(sourcePath)}, but could not confirm durable cleanup or restore it for retry: ${formatTerminalSafeDiagnosticValue(detail)}; ${formatTerminalSafeDiagnosticValue(restoreFailure)}`
            : `Could not confirm durable cleanup for completed Shields timer recovery artifact ${formatTerminalSafeDiagnosticValue(sourcePath)}; restored it for an explicit retry: ${formatTerminalSafeDiagnosticValue(detail)}`,
        };
      }
      try {
        fs.linkSync(quarantinePath, sourcePath);
        fs.unlinkSync(quarantinePath);
        return {
          status: "failed",
          warning: `Could not remove completed Shields timer recovery artifact ${formatTerminalSafeDiagnosticValue(sourcePath)}; restored it for retry: ${formatTerminalSafeDiagnosticValue(detail)}`,
        };
      } catch (restoreError) {
        const restoreDetail =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
        return {
          status: "failed",
          retainedPath: quarantinePath,
          warning: `Could not remove completed Shields timer recovery artifact ${formatTerminalSafeDiagnosticValue(sourcePath)} or restore it; retained ${formatTerminalSafeDiagnosticValue(quarantinePath)} for recovery: ${formatTerminalSafeDiagnosticValue(detail)}; ${formatTerminalSafeDiagnosticValue(restoreDetail)}`,
        };
      }
    }
  }

  try {
    fs.linkSync(quarantinePath, sourcePath);
    fs.unlinkSync(quarantinePath);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: errno.code === "EEXIST" ? "changed" : "failed",
      retainedPath: quarantinePath,
      warning: `Shields timer authority changed while retiring completed artifact ${formatTerminalSafeDiagnosticValue(sourcePath)}; retained ${formatTerminalSafeDiagnosticValue(quarantinePath)} for recovery: ${formatTerminalSafeDiagnosticValue(detail)}`,
    };
  }
  return {
    status: "changed",
    warning: `Shields timer authority changed while retiring completed artifact ${formatTerminalSafeDiagnosticValue(sourcePath)}`,
  };
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
  const timeout = remainingProcessInspectionTimeout(deadline);
  if (timeout === null) return null;
  return readTimerProcessStartIdentity(pid, timeout);
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
  if (
    marker.timerProcessStartIdentity !== undefined &&
    readProcessStartIdentity(marker.pid) !== marker.timerProcessStartIdentity
  ) {
    return {
      verified: false,
      warning: `PID ${String(marker.pid)} start identity does not match the shields timer for sandbox '${marker.sandboxName}'; clearing marker without signaling.`,
    };
  }
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
  authorityRevoked: boolean;
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
    authorityRevoked: markerClear.warning === undefined,
    markerFound: marker !== null,
    markerPid: marker?.pid ?? null,
    wasAlive,
    terminated: false,
    warnings,
  };
}

export type {
  ClearTimerMarkerResult,
  KillTimerResult,
  ShieldsTimerMarker as TimerMarker,
  TimerMarkerRetirementResult,
};
export {
  clearTimerMarker,
  clearTimerMarkerGeneration,
  formatTerminalSafeDiagnosticValue,
  hasExactTimerAuthorizationProof,
  hasQuarantinedShieldsTimerRecoveryArtifact,
  isShieldsTimerDeadlineAbandoned,
  isShieldsTimerMarkerAbandoned,
  isProcessAlive,
  killTimer,
  processInspectionDeadlineAfter,
  processInspectionDeadlineReached,
  readAutoRestoreTakeoverToken,
  readProcessStartIdentity,
  readProcessState,
  readTimerMarker,
  readShieldsTimerRecoveryCandidate,
  removeTimerAuthorizationProof,
  timerAuthoritySha256,
  timerAuthorizationProofPath,
  timerMarkerPath,
  sameTimerMarkerGeneration,
  verifyTimerMarkerIdentity,
  writeTimerAuthorizationProofForMarker,
};
