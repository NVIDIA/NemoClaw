// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { nemoclawStateRoot } from "../state-root";

export const onboardStateRoot = nemoclawStateRoot;

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export interface OnboardLockInfo {
  pid: number;
  startedAt: string | null;
  command: string | null;
}

export interface OnboardLockResult {
  acquired: boolean;
  lockFile: string;
  stale: boolean;
  holderPid?: number;
  holderStartedAt?: string | null;
  holderCommand?: string | null;
}

export interface OnboardStateLockHandle {
  readonly directoryDescriptor: number;
  readonly directoryStat: fs.Stats;
  readonly descriptor: number;
  readonly homeDir: string;
  lockFile: string;
  stateRoot: string;
}

export interface OnboardStateLockAcquisition extends OnboardLockResult {
  handle?: OnboardStateLockHandle;
}

interface LockFileSnapshot {
  info: OnboardLockInfo | null;
  inode: bigint;
  mtimeMs: number;
}

const MALFORMED_STALE_SECONDS = 30;
const MAX_ATTEMPTS = 5;

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertStateRootHasNoSymlinks(stateRoot: string, homeDir: string): void {
  const home = path.resolve(homeDir);
  let current = path.resolve(stateRoot);
  while (current !== home && current !== path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `NemoClaw onboarding state directory cannot be a symbolic link: ${current}`,
        );
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) throw error;
    }
    current = path.dirname(current);
  }
}

function openPinnedStateRoot(
  stateRoot: string,
  homeDir: string,
): {
  descriptor: number;
  stat: fs.Stats;
} {
  assertStateRootHasNoSymlinks(stateRoot, homeDir);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  assertStateRootHasNoSymlinks(stateRoot, homeDir);
  const descriptor = fs.openSync(
    stateRoot,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(stateRoot);
    if (
      !descriptorStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      !sameIdentity(descriptorStat, pathStat)
    ) {
      throw new Error("NemoClaw onboarding state directory changed during validation.");
    }
    return { descriptor, stat: descriptorStat };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function parseLockFile(contents: string): OnboardLockInfo | null {
  try {
    const value: unknown = JSON.parse(contents);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (!Number.isInteger(candidate.pid) || Number(candidate.pid) <= 0) return null;
    return {
      pid: Number(candidate.pid),
      startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : null,
      command: typeof candidate.command === "string" ? candidate.command : null,
    };
  } catch {
    return null;
  }
}

function readLockFileSnapshot(lockFile: string): LockFileSnapshot {
  const descriptor = fs.openSync(lockFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    return {
      info: stat.isFile() ? parseLockFile(String(fs.readFileSync(descriptor, "utf8"))) : null,
      inode: stat.ino,
      mtimeMs: Number(stat.mtimeMs),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrnoCode(error, "EPERM");
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
    return Number.isFinite(startTicks) ? (bootSeconds + startTicks / 100) * 1000 : null;
  } catch {
    return null;
  }
}

function lockHolderStillMatches(lock: OnboardLockInfo): boolean {
  if (!isProcessAlive(lock.pid)) return false;
  if (lock.pid === process.pid) return true;
  const lockStartedMs = lock.startedAt ? Date.parse(lock.startedAt) : NaN;
  if (!Number.isFinite(lockStartedMs)) return true;
  const processStartMs = readProcProcessStartMs(lock.pid);
  return processStartMs === null || processStartMs <= lockStartedMs + 1000;
}

function unlinkIfInodeMatches(filePath: string, expectedInode: bigint): void {
  try {
    if (fs.statSync(filePath, { bigint: true }).ino !== expectedInode) return;
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) throw error;
  }
}

export function assertOnboardStateLockOwned(handle: OnboardStateLockHandle): void {
  try {
    assertStateRootHasNoSymlinks(handle.stateRoot, handle.homeDir);
    const directoryDescriptorStat = fs.fstatSync(handle.directoryDescriptor);
    const directoryPathStat = fs.lstatSync(handle.stateRoot);
    const descriptorStat = fs.fstatSync(handle.descriptor);
    const pathStat = fs.lstatSync(handle.lockFile);
    if (
      sameIdentity(handle.directoryStat, directoryDescriptorStat) &&
      sameIdentity(handle.directoryStat, directoryPathStat) &&
      descriptorStat.isFile() &&
      descriptorStat.nlink === 1 &&
      !pathStat.isSymbolicLink() &&
      pathStat.isFile() &&
      pathStat.nlink === 1 &&
      sameIdentity(descriptorStat, pathStat)
    ) {
      return;
    }
  } catch {
    // Normalize filesystem races to the ownership contract below.
  }
  throw new Error("NemoClaw onboarding lock ownership changed during the operation.");
}

export function isOnboardStateLockOwned(handle: OnboardStateLockHandle): boolean {
  try {
    assertOnboardStateLockOwned(handle);
    return true;
  } catch {
    return false;
  }
}

export function retargetOnboardStateLock(handle: OnboardStateLockHandle, stateRoot: string): void {
  const previousStateRoot = handle.stateRoot;
  const previousLockFile = handle.lockFile;
  handle.stateRoot = stateRoot;
  handle.lockFile = path.join(stateRoot, "onboard.lock");
  try {
    assertOnboardStateLockOwned(handle);
  } catch (error) {
    handle.stateRoot = previousStateRoot;
    handle.lockFile = previousLockFile;
    throw error;
  }
}

export function acquireOnboardStateLock(
  stateRoot: string,
  homeDir: string,
  command: string | null = null,
  legacyMigrationLock?: string,
): OnboardStateLockAcquisition {
  const pinnedDirectory = openPinnedStateRoot(stateRoot, homeDir);
  const lockFile = path.join(stateRoot, "onboard.lock");
  const payload = JSON.stringify(
    { pid: process.pid, startedAt: new Date().toISOString(), command },
    null,
    2,
  );
  let directoryTransferred = false;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let descriptor: number;
      try {
        descriptor = fs.openSync(lockFile, "wx", 0o600);
      } catch (error) {
        if (!hasErrnoCode(error, "EEXIST")) throw error;
        let snapshot: LockFileSnapshot;
        try {
          snapshot = readLockFileSnapshot(lockFile);
        } catch (readError) {
          if (hasErrnoCode(readError, "ENOENT")) continue;
          throw readError;
        }
        if (!snapshot.info) {
          if (Date.now() - snapshot.mtimeMs > MALFORMED_STALE_SECONDS * 1000) {
            unlinkIfInodeMatches(lockFile, snapshot.inode);
          }
          continue;
        }
        if (lockHolderStillMatches(snapshot.info)) {
          return {
            acquired: false,
            lockFile,
            stale: false,
            holderPid: snapshot.info.pid,
            holderStartedAt: snapshot.info.startedAt,
            holderCommand: snapshot.info.command,
          };
        }
        unlinkIfInodeMatches(lockFile, snapshot.inode);
        continue;
      }
      try {
        fs.writeSync(descriptor, payload);
        const handle: OnboardStateLockHandle = {
          descriptor,
          directoryDescriptor: pinnedDirectory.descriptor,
          directoryStat: pinnedDirectory.stat,
          homeDir,
          lockFile,
          stateRoot,
        };
        assertOnboardStateLockOwned(handle);
        if (legacyMigrationLock && fs.existsSync(legacyMigrationLock)) {
          releaseOnboardStateLock(handle);
          return { acquired: false, lockFile, stale: false };
        }
        directoryTransferred = true;
        return { acquired: true, lockFile, stale: false, handle };
      } catch (error) {
        let inode: bigint | null = null;
        try {
          inode = fs.fstatSync(descriptor, { bigint: true }).ino;
          fs.closeSync(descriptor);
        } catch {
          // Best effort.
        }
        if (inode !== null) {
          try {
            unlinkIfInodeMatches(lockFile, inode);
          } catch {
            // Preserve the original error.
          }
        }
        throw error;
      }
    }
    return { acquired: false, lockFile, stale: true };
  } finally {
    if (!directoryTransferred) {
      try {
        fs.closeSync(pinnedDirectory.descriptor);
      } catch {
        // Best effort.
      }
    }
  }
}

export function releaseOnboardStateLock(handle: OnboardStateLockHandle): void {
  const quarantine = `${handle.lockFile}.release-${String(process.pid)}-${randomUUID()}`;
  try {
    if (!isOnboardStateLockOwned(handle)) return;
    try {
      fs.renameSync(handle.lockFile, quarantine);
    } catch {
      return;
    }
    const movedStat = fs.lstatSync(quarantine);
    const descriptorStat = fs.fstatSync(handle.descriptor);
    if (sameIdentity(movedStat, descriptorStat)) {
      fs.unlinkSync(quarantine);
      return;
    }
    try {
      fs.linkSync(quarantine, handle.lockFile);
    } finally {
      fs.unlinkSync(quarantine);
    }
  } catch {
    // Release is best effort. Never delete an unproved replacement lock.
  } finally {
    try {
      fs.closeSync(handle.descriptor);
    } catch {
      // Best effort.
    }
    try {
      fs.closeSync(handle.directoryDescriptor);
    } catch {
      // Best effort.
    }
  }
}
