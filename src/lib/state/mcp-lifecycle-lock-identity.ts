// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import {
  processIsAlive as hostProcessIsAlive,
  readProcessIdentity,
} from "../adapters/process/identity";

const LOCK_SCHEMA_VERSION = 1;

export interface McpLifecycleLockOwner {
  version: typeof LOCK_SCHEMA_VERSION;
  sandboxName: string;
  pid: number;
  processIdentity: string | null;
  /** Stable machine identity. A foreign owner is never reaped by local PID checks. */
  hostIdentity?: string | null;
  /** Linux PID namespace identity. Cross-namespace owners fail closed. */
  pidNamespaceIdentity?: string | null;
  /** Exact Shields timer generation correlated with this mutable-window operation. */
  shieldsTakeoverToken?: string;
  token: string;
  acquiredAt: string;
  /** Exact stale-generation evidence recorded by a durable containment owner. */
  containmentReason?: string;
  /** Machine-readable generation protected by a durable containment owner. */
  containedGeneration?: {
    target: "main" | "deadline" | "reaper";
    dev: number;
    ino: number;
    token: string;
    ownerPid: number | null;
  };
}

export interface LockObservation {
  owner: McpLifecycleLockOwner | null;
  mtimeMs: number;
  dev: number;
  ino: number;
  /** A directory cannot be restored with a hard link. */
  reclaimable: boolean;
}

export type McpLifecycleLockDisposition = "active" | "stale" | "wait";

/** Injectable OS evidence keeps ownership classification deterministic under test. */
export interface McpLifecycleLockIdentityProbes {
  localHostIdentity: string;
  localPidNamespaceIdentity: string | null;
  processIsAlive(pid: number): boolean;
  readProcessIdentity(pid: number, fresh?: boolean): string | null;
}

export function isMcpLifecycleLockOwner(value: unknown): value is McpLifecycleLockOwner {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const containedGeneration = candidate.containedGeneration;
  const generation = containedGeneration as Record<string, unknown>;
  const hasValidContainedGeneration =
    containedGeneration === undefined ||
    (containedGeneration !== null &&
      typeof containedGeneration === "object" &&
      (generation.target === "main" ||
        generation.target === "deadline" ||
        generation.target === "reaper") &&
      typeof generation.dev === "number" &&
      Number.isSafeInteger(generation.dev) &&
      generation.dev >= 0 &&
      typeof generation.ino === "number" &&
      Number.isSafeInteger(generation.ino) &&
      generation.ino >= 0 &&
      typeof generation.token === "string" &&
      generation.token.length > 0 &&
      (generation.ownerPid === null ||
        (typeof generation.ownerPid === "number" &&
          Number.isSafeInteger(generation.ownerPid) &&
          generation.ownerPid > 0)));
  return (
    candidate.version === LOCK_SCHEMA_VERSION &&
    typeof candidate.sandboxName === "string" &&
    Number.isSafeInteger(candidate.pid) &&
    (candidate.pid as number) > 0 &&
    (candidate.processIdentity === null || typeof candidate.processIdentity === "string") &&
    (candidate.hostIdentity === undefined ||
      candidate.hostIdentity === null ||
      typeof candidate.hostIdentity === "string") &&
    (candidate.pidNamespaceIdentity === undefined ||
      candidate.pidNamespaceIdentity === null ||
      typeof candidate.pidNamespaceIdentity === "string") &&
    (candidate.shieldsTakeoverToken === undefined ||
      (typeof candidate.shieldsTakeoverToken === "string" &&
        /^[0-9a-f]{32}$/.test(candidate.shieldsTakeoverToken))) &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.acquiredAt === "string" &&
    (candidate.containmentReason === undefined ||
      typeof candidate.containmentReason === "string") &&
    hasValidContainedGeneration
  );
}

export const processIsAlive = hostProcessIsAlive;

/**
 * Returns an OS process-start identity rather than only a PID. A stale lock
 * whose PID has been recycled must not be mistaken for its now-unrelated live
 * process. Linux exposes the kernel boot id plus /proc start ticks; macOS and
 * other supported POSIX hosts fall back to ps(1)'s process start timestamp.
 */
export function readMcpLockProcessIdentity(pid: number, fresh = false): string | null {
  return readProcessIdentity(pid, fresh, true);
}

/** Stable enough to distinguish independent hosts sharing a state directory. */
export function readMcpLockHostIdentity(): string {
  if (process.platform === "linux") {
    for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const machineId = fs.readFileSync(candidate, "utf8").trim();
        if (machineId) return `linux:${machineId}`;
      } catch {
        // Fall through to the hostname identity.
      }
    }
  }
  return `${process.platform}:${os.hostname() || "unknown-host"}`;
}

/** A shared state directory does not make local PID checks safe across namespaces. */
export function readMcpLockPidNamespaceIdentity(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return fs.readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}

const LOCAL_HOST_IDENTITY = readMcpLockHostIdentity();
const LOCAL_PID_NAMESPACE_IDENTITY = readMcpLockPidNamespaceIdentity();

const LOCAL_IDENTITY_PROBES: McpLifecycleLockIdentityProbes = {
  localHostIdentity: LOCAL_HOST_IDENTITY,
  localPidNamespaceIdentity: LOCAL_PID_NAMESPACE_IDENTITY,
  processIsAlive,
  readProcessIdentity: readMcpLockProcessIdentity,
};

export function createMcpLifecycleLockOwner(
  sandboxName: string,
  token: string,
  shieldsTakeoverToken?: string,
): McpLifecycleLockOwner {
  return {
    version: LOCK_SCHEMA_VERSION,
    sandboxName,
    pid: process.pid,
    processIdentity: readMcpLockProcessIdentity(process.pid),
    hostIdentity: LOCAL_HOST_IDENTITY,
    pidNamespaceIdentity: LOCAL_PID_NAMESPACE_IDENTITY,
    ...(shieldsTakeoverToken ? { shieldsTakeoverToken } : {}),
    token,
    acquiredAt: new Date().toISOString(),
  };
}

/** Exported for deterministic stale-owner/PID-recycle tests. */
export function classifyMcpLifecycleLock(
  observation: LockObservation,
  sandboxName: string,
  nowMs: number,
  corruptLockGraceMs: number,
  probes: McpLifecycleLockIdentityProbes = LOCAL_IDENTITY_PROBES,
): McpLifecycleLockDisposition {
  const { owner } = observation;
  if (!owner || owner.sandboxName !== sandboxName) {
    return observation.reclaimable && nowMs - observation.mtimeMs >= corruptLockGraceMs
      ? "stale"
      : "wait";
  }
  // The lock coordinates local CLI processes, not independent hosts or PID
  // namespaces. Never use this process's PID table to reap a foreign owner;
  // wait for operator/distributed-lease resolution instead of risking overlap.
  // Legacy or incomplete records have unknown provenance. Treat them as
  // foreign instead of using this host's PID table to reap them.
  if (!owner.hostIdentity || owner.hostIdentity !== probes.localHostIdentity) return "active";
  if (
    (probes.localPidNamespaceIdentity !== null && !owner.pidNamespaceIdentity) ||
    (owner.pidNamespaceIdentity !== null &&
      owner.pidNamespaceIdentity !== undefined &&
      owner.pidNamespaceIdentity !== probes.localPidNamespaceIdentity)
  ) {
    return "active";
  }
  if (!probes.processIsAlive(owner.pid)) return "stale";

  const observedIdentity = probes.readProcessIdentity(owner.pid);
  if (
    owner.processIdentity !== null &&
    observedIdentity !== null &&
    owner.processIdentity !== observedIdentity
  ) {
    // PID identities are cached briefly. Confirm a mismatch without the cache
    // before reaping so rapid PID reuse cannot evict a newly live owner.
    const refreshedIdentity = probes.readProcessIdentity(owner.pid, true);
    if (refreshedIdentity !== null && owner.processIdentity !== refreshedIdentity) {
      return "stale";
    }
  }
  // If this OS cannot recover process-start identity, a live PID is treated as
  // active. Failing closed may require waiting for that process to exit, but it
  // never breaks mutual exclusion for a legitimate long rebuild/destroy.
  return "active";
}
