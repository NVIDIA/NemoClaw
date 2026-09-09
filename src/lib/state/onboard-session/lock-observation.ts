// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  readMcpLockPidNamespaceIdentity,
  readMcpLockProcessIdentity,
  readMcpLockStableHostIdentity,
} from "../mcp-lifecycle-lock-identity";

const MAX_LOCK_BYTES = 64 * 1024;
const MAX_PROCESS_ID = 0x7fffffff;

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
  | {
      kind: "stale";
      reason: "departed" | "pid-reused";
      owner: OnboardLockOwner;
    }
  | {
      kind: "busy";
      reason: "active" | "foreign" | "unverified" | "publishing" | "unsafe";
      owner?: OnboardLockOwner;
    };

export interface OnboardLockFileSnapshot {
  contents: string;
  inode: bigint;
  mtimeMs: number;
}

export interface OnboardLockInspection {
  observation: OnboardLockObservation;
  snapshot?: OnboardLockFileSnapshot;
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

export const systemOnboardLockEvidence: OnboardLockEvidence = {
  hostIdentity: readMcpLockStableHostIdentity,
  pidNamespaceIdentity: () =>
    readMcpLockPidNamespaceIdentity() ??
    (process.platform === "linux" ? null : `${process.platform}:host-pid-namespace`),
  processGeneration: (pid) => readMcpLockProcessIdentity(pid, true),
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
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    record.pid > MAX_PROCESS_ID ||
    typeof record.processGeneration !== "string" ||
    record.processGeneration.length === 0 ||
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

export function inspectOnboardLock(
  lockPath: string,
  evidence: OnboardLockEvidence = systemOnboardLockEvidence,
): OnboardLockInspection {
  let fd: number;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { observation: { kind: "absent" } };
    return { observation: { kind: "busy", reason: "unsafe" } };
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
      return { observation: { kind: "busy", reason: "unsafe" } };
    }
    const bytes = Buffer.alloc(Math.min(MAX_LOCK_BYTES + 1, before.size + 1));
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (
      length > MAX_LOCK_BYTES ||
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      return { observation: { kind: "busy", reason: "publishing" } };
    }
    const snapshot: OnboardLockFileSnapshot = {
      contents: bytes.subarray(0, length).toString("utf8"),
      inode: fs.fstatSync(fd, { bigint: true }).ino,
      mtimeMs: before.mtimeMs,
    };
    let value: unknown;
    try {
      value = JSON.parse(snapshot.contents);
    } catch {
      return { observation: { kind: "busy", reason: "unverified" }, snapshot };
    }
    const owner = parseOwner(value);
    if (!owner) {
      return { observation: { kind: "busy", reason: "unverified" }, snapshot };
    }

    const hostIdentity = evidence.hostIdentity();
    const pidNamespaceIdentity = evidence.pidNamespaceIdentity();
    if (!hostIdentity || !pidNamespaceIdentity)
      return { observation: { kind: "busy", reason: "unverified", owner }, snapshot };
    if (
      owner.hostIdentity !== hostIdentity ||
      owner.pidNamespaceIdentity !== pidNamespaceIdentity
    ) {
      return { observation: { kind: "busy", reason: "foreign", owner }, snapshot };
    }
    if (!evidence.processAlive(owner.pid)) {
      return { observation: { kind: "stale", reason: "departed", owner }, snapshot };
    }
    const generation = evidence.processGeneration(owner.pid);
    if (!generation) {
      return { observation: { kind: "busy", reason: "unverified", owner }, snapshot };
    }
    if (generation !== owner.processGeneration) {
      return { observation: { kind: "stale", reason: "pid-reused", owner }, snapshot };
    }
    return { observation: { kind: "busy", reason: "active", owner }, snapshot };
  } catch {
    return { observation: { kind: "busy", reason: "unverified" } };
  } finally {
    fs.closeSync(fd);
  }
}

export function observeOnboardLock(
  lockPath: string,
  evidence: OnboardLockEvidence = systemOnboardLockEvidence,
): OnboardLockObservation {
  return inspectOnboardLock(lockPath, evidence).observation;
}
