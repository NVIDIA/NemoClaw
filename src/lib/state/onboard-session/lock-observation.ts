// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { isErrnoException } from "../../core/errno";

const MAX_LOCK_BYTES = 64 * 1024;

export interface OnboardLockOwner {
  pid: number;
  startedAt: string | null;
  command: string | null;
  processGeneration: string;
  hostIdentity: string;
  pidNamespaceIdentity: string;
}

export interface OnboardLockEvidence {
  hostIdentity(): string | null;
  pidNamespaceIdentity(): string | null;
  processGeneration(pid: number): string | null;
  processAlive(pid: number): boolean;
}

export type OnboardLockObservation =
  | { kind: "absent" }
  | { kind: "stale"; reason: "departed" | "pid-reused"; owner: OnboardLockOwner }
  | {
      kind: "busy";
      reason: "active" | "foreign" | "unverified" | "publishing" | "unsafe";
      owner?: OnboardLockOwner;
    };

function readTrimmed(path: string): string | null {
  try {
    const value = fs.readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function linuxProcessGeneration(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks || !/^[0-9]+$/.test(startTicks)) return null;
    const bootIdentity =
      readTrimmed("/proc/sys/kernel/random/boot_id") ??
      fs
        .readFileSync("/proc/stat", "utf8")
        .split("\n")
        .find((line) => line.startsWith("btime "))
        ?.slice("btime ".length)
        .trim();
    return bootIdentity ? `linux:${bootIdentity}:${startTicks}` : null;
  } catch {
    return null;
  }
}

export const systemOnboardLockEvidence: OnboardLockEvidence = {
  hostIdentity: () => readTrimmed("/etc/machine-id"),
  pidNamespaceIdentity: () => {
    try {
      return fs.readlinkSync("/proc/self/ns/pid");
    } catch {
      return null;
    }
  },
  processGeneration: (pid) => (process.platform === "linux" ? linuxProcessGeneration(pid) : null),
  processAlive: defaultProcessAlive,
};

export function createOnboardLockOwner(
  command: string | null,
  evidence: OnboardLockEvidence = systemOnboardLockEvidence,
): OnboardLockOwner | null {
  const hostIdentity = evidence.hostIdentity();
  const pidNamespaceIdentity = evidence.pidNamespaceIdentity();
  const processGeneration = evidence.processGeneration(process.pid);
  if (!hostIdentity || !pidNamespaceIdentity || !processGeneration) return null;
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command,
    processGeneration,
    hostIdentity,
    pidNamespaceIdentity,
  };
}

function parseOwner(value: unknown): OnboardLockOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.pid) ||
    typeof record.processGeneration !== "string" ||
    typeof record.hostIdentity !== "string" ||
    typeof record.pidNamespaceIdentity !== "string"
  ) {
    return null;
  }
  return {
    pid: record.pid as number,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
    command: typeof record.command === "string" ? record.command : null,
    processGeneration: record.processGeneration,
    hostIdentity: record.hostIdentity,
    pidNamespaceIdentity: record.pidNamespaceIdentity,
  };
}

export function observeOnboardLock(
  lockPath: string,
  evidence: OnboardLockEvidence = systemOnboardLockEvidence,
): OnboardLockObservation {
  let fd: number;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return { kind: "absent" };
    return { kind: "busy", reason: "unsafe" };
  }

  try {
    const before = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(lockPath);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > MAX_LOCK_BYTES ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.nlink !== 1 ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino
    ) {
      return { kind: "busy", reason: "unsafe" };
    }
    const bytes = Buffer.alloc(Math.min(MAX_LOCK_BYTES + 1, before.size + 1));
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (
      length > MAX_LOCK_BYTES ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      return { kind: "busy", reason: "publishing" };
    }
    const owner = parseOwner(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    if (!owner) return { kind: "busy", reason: "unverified" };

    const hostIdentity = evidence.hostIdentity();
    const pidNamespaceIdentity = evidence.pidNamespaceIdentity();
    if (!hostIdentity || !pidNamespaceIdentity)
      return { kind: "busy", reason: "unverified", owner };
    if (
      owner.hostIdentity !== hostIdentity ||
      owner.pidNamespaceIdentity !== pidNamespaceIdentity
    ) {
      return { kind: "busy", reason: "foreign", owner };
    }
    if (!evidence.processAlive(owner.pid)) return { kind: "stale", reason: "departed", owner };
    const generation = evidence.processGeneration(owner.pid);
    if (!generation) return { kind: "busy", reason: "unverified", owner };
    if (generation !== owner.processGeneration)
      return { kind: "stale", reason: "pid-reused", owner };
    return { kind: "busy", reason: "active", owner };
  } catch {
    return { kind: "busy", reason: "unverified" };
  } finally {
    fs.closeSync(fd);
  }
}
