// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { isErrnoException } from "../core/errno";
import { buildSubprocessEnv } from "../subprocess-env";

const LOCK_SCHEMA_VERSION = 1;
const OWNER_IDENTITY_CACHE_MS = 1_000;

export interface McpLifecycleLockOwner {
  version: typeof LOCK_SCHEMA_VERSION;
  sandboxName: string;
  pid: number;
  processIdentity: string | null;
  /** Stable machine identity. A foreign owner is never reaped by local PID checks. */
  hostIdentity?: string | null;
  /** Linux PID namespace identity. Cross-namespace owners fail closed. */
  pidNamespaceIdentity?: string | null;
  token: string;
  acquiredAt: string;
}

export interface LockObservation {
  owner: McpLifecycleLockOwner | null;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export type McpLifecycleLockDisposition = "active" | "stale" | "wait";

/** Injectable OS evidence keeps ownership classification deterministic under test. */
export interface McpLifecycleLockIdentityProbes {
  localHostIdentity: string;
  localPidNamespaceIdentity: string | null;
  processIsAlive(pid: number): boolean;
  readProcessIdentity(pid: number, fresh?: boolean): string | null;
}

const processIdentityCache = new Map<number, { checkedAt: number; identity: string | null }>();

export function isMcpLifecycleLockOwner(value: unknown): value is McpLifecycleLockOwner {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
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
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.acquiredAt === "string"
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/**
 * Returns an OS process-start identity rather than only a PID. A stale lock
 * whose PID has been recycled must not be mistaken for its now-unrelated live
 * process. Linux exposes the kernel boot id plus /proc start ticks; macOS and
 * other supported POSIX hosts fall back to ps(1)'s process start timestamp.
 */
export function readMcpLockProcessIdentity(pid: number, fresh = false): string | null {
  const cached = processIdentityCache.get(pid);
  const now = performance.now();
  if (
    !fresh &&
    cached &&
    now >= cached.checkedAt &&
    now - cached.checkedAt < OWNER_IDENTITY_CACHE_MS
  ) {
    return cached.identity;
  }

  let identity: string | null = null;
  if (process.platform === "linux") {
    try {
      const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = statText.lastIndexOf(")");
      if (closeParen >= 0) {
        const fieldsAfterComm = statText
          .slice(closeParen + 2)
          .trim()
          .split(/\s+/);
        // The first value after comm is field 3; index 19 is field 22,
        // process start time in clock ticks since boot.
        const startTicks = fieldsAfterComm[19];
        if (startTicks && /^\d+$/.test(startTicks)) {
          let bootIdentity = "unknown-boot";
          try {
            bootIdentity = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
          } catch {
            const bootTime = fs
              .readFileSync("/proc/stat", "utf8")
              .split("\n")
              .find((line) => line.startsWith("btime "));
            if (bootTime) bootIdentity = bootTime.trim();
          }
          identity = `linux:${bootIdentity}:${startTicks}`;
        }
      }
    } catch {
      identity = null;
    }
  } else {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: buildSubprocessEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    const startedAt = result.status === 0 ? result.stdout.trim() : "";
    if (startedAt) identity = `${process.platform}:${startedAt}`;
  }

  processIdentityCache.set(pid, { checkedAt: now, identity });
  return identity;
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
): McpLifecycleLockOwner {
  return {
    version: LOCK_SCHEMA_VERSION,
    sandboxName,
    pid: process.pid,
    processIdentity: readMcpLockProcessIdentity(process.pid),
    hostIdentity: LOCAL_HOST_IDENTITY,
    pidNamespaceIdentity: LOCAL_PID_NAMESPACE_IDENTITY,
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
    return nowMs - observation.mtimeMs >= corruptLockGraceMs ? "stale" : "wait";
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
