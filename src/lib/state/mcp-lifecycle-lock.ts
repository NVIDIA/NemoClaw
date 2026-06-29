// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { isErrnoException } from "../core/errno";
import { resolveNemoclawStateDir } from "./paths";

const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CORRUPT_LOCK_GRACE_MS = 30_000;
const OWNER_IDENTITY_CACHE_MS = 1_000;

export const MCP_LIFECYCLE_LOCK_DIRNAME = "mcp-lifecycle-locks";

interface McpLifecycleLockOwner {
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

interface LockObservation {
  owner: McpLifecycleLockOwner | null;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface CorruptGenerationTracker {
  generation: string | null;
  firstSeenAt: number;
}

interface AcquiredMcpLifecycleLock {
  lockPath: string;
  token: string;
}

export interface McpLifecycleLockOptions {
  /** Override used by focused tests. Production callers use ~/.nemoclaw/state. */
  stateDir?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  corruptLockGraceMs?: number;
}

interface HeldLockLease {
  active: boolean;
}

type HeldLockContext = ReadonlyMap<string, HeldLockLease>;

const heldLocks = new AsyncLocalStorage<HeldLockContext>();
const processIdentityCache = new Map<number, { checkedAt: number; identity: string | null }>();

function isLockOwner(value: unknown): value is McpLifecycleLockOwner {
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

function lockFileStem(sandboxName: string): string {
  // Hashing makes the filesystem key traversal-safe even if a caller reaches
  // the lock before the command's normal sandbox-name validation.
  return crypto.createHash("sha256").update(sandboxName).digest("hex");
}

export function getMcpLifecycleLockPath(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): string {
  return path.join(stateDir, MCP_LIFECYCLE_LOCK_DIRNAME, `${lockFileStem(sandboxName)}.lock`);
}

function ownerFileContent(owner: McpLifecycleLockOwner): string {
  return `${JSON.stringify(owner)}\n`;
}

function createLockOwner(sandboxName: string, token: string): McpLifecycleLockOwner {
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

async function readLockObservation(lockPath: string): Promise<LockObservation | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    try {
      const stat = await fs.promises.lstat(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { owner: null, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
      }
    } catch (statError) {
      if (isErrnoException(statError) && statError.code === "ENOENT") return null;
      throw statError;
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { owner: null, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    }
    try {
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      return {
        owner: isLockOwner(parsed) ? parsed : null,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
      };
    } catch {
      return { owner: null, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    }
  } finally {
    await handle.close();
  }
}

export type McpLifecycleLockDisposition = "active" | "stale" | "wait";

/** Exported for deterministic stale-owner/PID-recycle tests. */
export function classifyMcpLifecycleLock(
  observation: LockObservation,
  sandboxName: string,
  nowMs: number,
  corruptLockGraceMs: number,
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
  if (!owner.hostIdentity || owner.hostIdentity !== LOCAL_HOST_IDENTITY) return "active";
  if (
    (LOCAL_PID_NAMESPACE_IDENTITY !== null && !owner.pidNamespaceIdentity) ||
    (owner.pidNamespaceIdentity !== null &&
      owner.pidNamespaceIdentity !== undefined &&
      owner.pidNamespaceIdentity !== LOCAL_PID_NAMESPACE_IDENTITY)
  ) {
    return "active";
  }
  if (!processIsAlive(owner.pid)) return "stale";

  const observedIdentity = readMcpLockProcessIdentity(owner.pid);
  if (
    owner.processIdentity !== null &&
    observedIdentity !== null &&
    owner.processIdentity !== observedIdentity
  ) {
    // PID identities are cached briefly. Confirm a mismatch without the cache
    // before reaping so rapid PID reuse cannot evict a newly live owner.
    const refreshedIdentity = readMcpLockProcessIdentity(owner.pid, true);
    if (refreshedIdentity !== null && owner.processIdentity !== refreshedIdentity) {
      return "stale";
    }
  }
  // If this OS cannot recover process-start identity, a live PID is treated as
  // active. Failing closed may require waiting for that process to exit, but it
  // never breaks mutual exclusion for a legitimate long rebuild/destroy.
  return "active";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetCorruptGenerationTracker(tracker: CorruptGenerationTracker): void {
  tracker.generation = null;
  tracker.firstSeenAt = 0;
}

/** Age one continuously observed corrupt inode with a monotonic clock. */
function classifyObservedMcpLifecycleLock(
  observation: LockObservation,
  sandboxName: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationTracker,
): McpLifecycleLockDisposition {
  if (!observation.owner || observation.owner.sandboxName !== sandboxName) {
    const generation = `${observation.dev}:${observation.ino}:${observation.mtimeMs}`;
    const now = performance.now();
    if (corruptTracker.generation !== generation) {
      corruptTracker.generation = generation;
      corruptTracker.firstSeenAt = now;
      return "wait";
    }
    return now - corruptTracker.firstSeenAt >= corruptLockGraceMs ? "stale" : "wait";
  }
  resetCorruptGenerationTracker(corruptTracker);
  // The wall-clock arguments are irrelevant for a structurally valid owner.
  return classifyMcpLifecycleLock(
    observation,
    sandboxName,
    observation.mtimeMs,
    corruptLockGraceMs,
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function safelyReleaseLock(lockPath: string, token: string): Promise<void> {
  const observation = await readLockObservation(lockPath);
  if (!observation || observation.owner?.token !== token) return;
  // Claim and verify the generation before deletion. A replacement appearing
  // after the token read is restored rather than unlinked.
  await reclaimStaleGeneration(lockPath, observation);
}

async function reclaimStaleGeneration(
  targetPath: string,
  expected: LockObservation,
): Promise<boolean> {
  const quarantinePath = `${targetPath}.reclaim-${process.pid}-${crypto.randomUUID()}`;
  try {
    // Rename is the atomic claim. Another waiter may have already removed the
    // stale generation and published a replacement after our earlier read, so
    // the moved file must be verified before it is ever deleted.
    await fs.promises.rename(targetPath, quarantinePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }

  const claimed = await readLockObservation(quarantinePath);
  const expectedToken = expected.owner?.token ?? null;
  const claimedExpectedGeneration =
    expectedToken === null
      ? claimed !== null &&
        claimed.owner === null &&
        claimed.dev === expected.dev &&
        claimed.ino === expected.ino
      : claimed?.owner?.token === expectedToken;
  if (claimedExpectedGeneration) {
    await fs.promises.rm(quarantinePath, { force: true, recursive: true });
    return true;
  }

  // We raced a replacement owner. Restore the exact moved inode with a hard
  // link (which cannot overwrite a newer generation), then drop only our
  // quarantine name. If another generation already occupies the canonical
  // path, preserve the displaced owner record for diagnosis rather than ever
  // deleting an owner we did not claim.
  try {
    await fs.promises.link(quarantinePath, targetPath);
    await fs.promises.rm(quarantinePath, { force: true });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
  return false;
}

async function tryReapStaleLock(
  lockPath: string,
  sandboxName: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationTracker,
): Promise<boolean> {
  const reaperPath = `${lockPath}.reaper`;
  const reaperToken = crypto.randomUUID();
  const reaperOwner = createLockOwner(sandboxName, reaperToken);
  if (!(await writeCandidateAndLink(reaperPath, reaperOwner))) return false;

  try {
    const latest = await readLockObservation(lockPath);
    if (!latest) return true;
    if (
      classifyObservedMcpLifecycleLock(latest, sandboxName, corruptLockGraceMs, corruptTracker) !==
      "stale"
    ) {
      return false;
    }

    return reclaimStaleGeneration(lockPath, latest);
  } finally {
    await safelyReleaseLock(reaperPath, reaperToken);
  }
}

async function writeCandidateAndLink(
  lockPath: string,
  owner: McpLifecycleLockOwner,
): Promise<boolean> {
  const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.token}`;
  try {
    const handle = await fs.promises.open(candidatePath, "wx", 0o600);
    try {
      await handle.writeFile(ownerFileContent(owner), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // The hard link is the atomic publication point: waiters can never see a
      // partially written owner record.
      await fs.promises.link(candidatePath, lockPath);
      return true;
    } catch (error) {
      // NFS may execute LINK but lose/replay its reply. Reconcile the result
      // from the unique candidate's link count plus our unguessable owner token
      // before treating EEXIST (or another transport error) as a failed claim.
      const candidateStat = await fs.promises.stat(candidatePath);
      const published = await readLockObservation(lockPath);
      if (candidateStat.nlink >= 2 && published?.owner?.token === owner.token) {
        return true;
      }
      if (isErrnoException(error) && error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      await fs.promises.rm(candidatePath, { force: true });
    } catch {
      // Publication is decided only by LINK plus owner-token reconciliation.
      // A unique candidate cleanup failure must not strand a live canonical
      // self-lock before the caller enters its protected operation.
    }
  }
}

async function acquireMcpLifecycleLock(
  sandboxName: string,
  options: McpLifecycleLockOptions,
): Promise<AcquiredMcpLifecycleLock> {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptLockGraceMs = positiveInteger(
    options.corruptLockGraceMs,
    DEFAULT_CORRUPT_LOCK_GRACE_MS,
  );
  const lockPath = getMcpLifecycleLockPath(sandboxName, options.stateDir);
  await fs.promises.mkdir(path.dirname(lockPath), {
    recursive: true,
    mode: 0o700,
  });

  const startedAt = performance.now();
  const corruptMainTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  const corruptReaperTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  let lastOwnerPid: number | null = null;
  for (;;) {
    if (performance.now() - startedAt >= timeoutMs) {
      const ownerSuffix = lastOwnerPid ? ` (owner pid ${lastOwnerPid})` : "";
      throw new Error(
        `Timed out waiting for MCP lifecycle lock for sandbox '${sandboxName}'${ownerSuffix}. Another add, restart, remove, rebuild, or destroy operation is still running.`,
      );
    }

    const reaperPath = `${lockPath}.reaper`;
    const reaperObservation = await readLockObservation(reaperPath);
    if (reaperObservation) {
      const reaperDisposition = classifyObservedMcpLifecycleLock(
        reaperObservation,
        sandboxName,
        corruptLockGraceMs,
        corruptReaperTracker,
      );
      if (reaperDisposition === "stale") {
        // The reaper has the same atomic, PID-identified owner format as the
        // main lock. A SIGKILL at any point in stale-lock cleanup is therefore
        // recoverable without age-expiring a legitimate long operation.
        await reclaimStaleGeneration(reaperPath, reaperObservation);
        continue;
      }
      await sleep(pollIntervalMs);
      continue;
    }
    resetCorruptGenerationTracker(corruptReaperTracker);

    if (!(await pathExists(reaperPath))) {
      const token = crypto.randomUUID();
      const owner = createLockOwner(sandboxName, token);
      if (await writeCandidateAndLink(lockPath, owner)) {
        // A stale-lock reaper may have appeared between our pre-check and the
        // atomic link. Do not enter the critical section until that generation
        // gate has gone away.
        if (!(await pathExists(reaperPath))) return { lockPath, token };
        await safelyReleaseLock(lockPath, token);
      }
    }

    const observation = await readLockObservation(lockPath);
    if (observation) {
      lastOwnerPid = observation.owner?.pid ?? null;
      if (
        classifyObservedMcpLifecycleLock(
          observation,
          sandboxName,
          corruptLockGraceMs,
          corruptMainTracker,
        ) === "stale"
      ) {
        if (await tryReapStaleLock(lockPath, sandboxName, corruptLockGraceMs, corruptMainTracker)) {
          continue;
        }
      }
    } else {
      resetCorruptGenerationTracker(corruptMainTracker);
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Serializes the complete MCP lifecycle for one sandbox across processes.
 * AsyncLocalStorage makes nested calls in the same lifecycle operation
 * reentrant (rebuild recovery -> MCP restart), while separate top-level
 * promises in one Node process still contend on the filesystem lock.
 *
 * The lease is host-local. If a state directory is shared across machines or
 * PID namespaces, foreign owners fail closed and require operator/distributed
 * lease resolution; local PID probing is never used to reap them.
 *
 * This is a CLI state lock only. It is not an MCP bridge, proxy, listener, or
 * credential process and never participates in sandbox network traffic.
 */
export async function withMcpLifecycleLock<T>(
  sandboxName: string,
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  const stateDir = options.stateDir ?? resolveNemoclawStateDir();
  const lockKey = getMcpLifecycleLockPath(sandboxName, stateDir);
  const inherited = heldLocks.getStore();
  if (inherited?.get(lockKey)?.active) return await operation();

  const acquired = await acquireMcpLifecycleLock(sandboxName, {
    ...options,
    stateDir,
  });
  const lease: HeldLockLease = { active: true };
  const context = new Map(inherited ?? []);
  context.set(lockKey, lease);
  return heldLocks.run(context, async () => {
    try {
      return await operation();
    } finally {
      // Async resources created by the callback retain their ALS store. Mark
      // the lease inactive before releasing so a detached/later promise cannot
      // mistake an ended parent operation for a still-held reentrant lock.
      lease.active = false;
      await safelyReleaseLock(acquired.lockPath, acquired.token);
    }
  });
}
