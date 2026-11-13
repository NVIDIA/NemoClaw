// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  /** A directory cannot be restored with a hard link. */
  reclaimable: boolean;
}

export type McpLifecycleLockDisposition = "active" | "stale" | "wait";

/** Injectable OS evidence keeps ownership classification deterministic under test. */
export interface McpLifecycleLockIdentityProbes {
  localHostIdentity: string;
  /**
   * Earlier identities this same host may have recorded, such as the legacy
   * `<platform>:<hostname>` form. Matching one proves the owner is local.
   */
  localHostIdentityAliases?: readonly string[];
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

function readLinuxProcessState(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    if (closeParen < 0) return null;
    return (
      statText
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/)[0] ?? null
    );
  } catch {
    return null;
  }
}

export function processIsAlive(pid: number): boolean {
  // kill(pid, 0) succeeds for an unreaped zombie even though it can no longer
  // own or release a lifecycle lock.
  if (readLinuxProcessState(pid) === "Z") return false;
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

/** The pre-stable-identity form. macOS can rename the host on its own. */
export function readMcpLockLegacyHostIdentity(): string {
  return `${process.platform}:${os.hostname() || "unknown-host"}`;
}

/** Parses IOPlatformUUID from `ioreg -rd1 -c IOPlatformExpertDevice` output. */
export function parseIoregPlatformUuid(output: string): string | null {
  const match = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(output);
  return match ? match[1].toUpperCase() : null;
}

function readDarwinPlatformUuid(): string | null {
  const result = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
    encoding: "utf8",
    env: buildSubprocessEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  return result.status === 0 && typeof result.stdout === "string"
    ? parseIoregPlatformUuid(result.stdout)
    : null;
}

/**
 * Stable enough to distinguish independent hosts sharing a state directory.
 * The hostname is only a last resort: macOS changes it on Bonjour/DHCP name
 * conflicts, which would make every lock left by a dead local CLI look foreign.
 */
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
  if (process.platform === "darwin") {
    const platformUuid = readDarwinPlatformUuid();
    if (platformUuid) {
      // Hash so the raw hardware UUID is not written to lock files.
      const digest = createHash("sha256").update(platformUuid).digest("hex");
      return `darwin:platform-uuid:${digest}`;
    }
  }
  return readMcpLockLegacyHostIdentity();
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

/**
 * Maps the names this Mac reports right now to the hostname-based identities a
 * pre-stable-identity CLI wrote (`darwin:<os.hostname()>`). Only names macOS
 * currently assigns to this host are used. Former or guessed names (such as
 * Bonjour "-2" conflict variants) are never synthesized: another Mac sharing
 * the state directory may own them, and the local PID table cannot prove that
 * a foreign owner is dead.
 */
export function darwinLegacyHostIdentityAliases(names: {
  hostname?: string | null;
  localHostName?: string | null;
  hostName?: string | null;
}): string[] {
  const candidates = [
    names.hostname?.trim(),
    names.localHostName?.trim() ? `${names.localHostName.trim()}.local` : undefined,
    names.hostName?.trim(),
  ];
  return [...new Set(candidates.filter((name): name is string => Boolean(name)))].map(
    (name) => `darwin:${name}`,
  );
}

function readDarwinScutilName(key: "LocalHostName" | "HostName"): string | null {
  const result = spawnSync("/usr/sbin/scutil", ["--get", key], {
    encoding: "utf8",
    env: buildSubprocessEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
  return result.status === 0 && typeof result.stdout === "string"
    ? result.stdout.trim() || null
    : null;
}

/** Hostname-based identities that currently name this host. Excludes the current identity. */
function readLocalLegacyHostIdentityAliases(): string[] {
  const legacy = readMcpLockLegacyHostIdentity();
  const aliases =
    process.platform === "darwin" && LOCAL_HOST_IDENTITY !== legacy
      ? darwinLegacyHostIdentityAliases({
          hostname: os.hostname(),
          localHostName: readDarwinScutilName("LocalHostName"),
          hostName: readDarwinScutilName("HostName"),
        })
      : [legacy];
  return aliases.filter((alias) => alias !== LOCAL_HOST_IDENTITY);
}

const LOCAL_IDENTITY_PROBES: McpLifecycleLockIdentityProbes = {
  localHostIdentity: LOCAL_HOST_IDENTITY,
  // Pre-stable-identity locks from this host recorded one of its current hostnames.
  localHostIdentityAliases: readLocalLegacyHostIdentityAliases(),
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
    return observation.reclaimable && nowMs - observation.mtimeMs >= corruptLockGraceMs
      ? "stale"
      : "wait";
  }
  // The lock coordinates local CLI processes, not independent hosts or PID
  // namespaces. Never use this process's PID table to reap a foreign owner;
  // wait for operator/distributed-lease resolution instead of risking overlap.
  // Legacy or incomplete records have unknown provenance. Treat them as
  // foreign instead of using this host's PID table to reap them.
  if (
    !owner.hostIdentity ||
    (owner.hostIdentity !== probes.localHostIdentity &&
      !(probes.localHostIdentityAliases ?? []).includes(owner.hostIdentity))
  ) {
    return "active";
  }
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
