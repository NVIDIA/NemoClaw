// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  classifyMcpLifecycleLock,
  createMcpLifecycleLockOwner,
  type LockObservation,
  type McpLifecycleLockDisposition,
} from "./mcp-lifecycle-lock-identity";
import {
  getMcpLifecycleLockPath,
  mcpLifecycleLockPathExists,
  readMcpLifecycleLockObservation,
  reclaimStaleMcpLifecycleLockGeneration,
  safelyReleaseMcpLifecycleLock,
  writeMcpLifecycleLockCandidateAndLink,
} from "./mcp-lifecycle-lock-storage";
import { resolveNemoclawStateDir } from "./paths";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CORRUPT_LOCK_GRACE_MS = 30_000;

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

async function tryReapStaleLock(
  lockPath: string,
  sandboxName: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationTracker,
): Promise<boolean> {
  const reaperPath = `${lockPath}.reaper`;
  const reaperToken = crypto.randomUUID();
  const reaperOwner = createMcpLifecycleLockOwner(sandboxName, reaperToken);
  if (!(await writeMcpLifecycleLockCandidateAndLink(reaperPath, reaperOwner))) return false;

  try {
    const latest = await readMcpLifecycleLockObservation(lockPath);
    if (!latest) return true;
    if (
      classifyObservedMcpLifecycleLock(latest, sandboxName, corruptLockGraceMs, corruptTracker) !==
      "stale"
    ) {
      return false;
    }

    return reclaimStaleMcpLifecycleLockGeneration(lockPath, latest);
  } finally {
    await safelyReleaseMcpLifecycleLock(reaperPath, reaperToken);
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
        `Timed out waiting for the sandbox mutation lock for '${sandboxName}'${ownerSuffix}. Another lifecycle, policy, channel, shields, or snapshot operation is still running.`,
      );
    }

    const reaperPath = `${lockPath}.reaper`;
    const reaperObservation = await readMcpLifecycleLockObservation(reaperPath);
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
        await reclaimStaleMcpLifecycleLockGeneration(reaperPath, reaperObservation);
        continue;
      }
      await sleep(pollIntervalMs);
      continue;
    }
    resetCorruptGenerationTracker(corruptReaperTracker);

    if (!(await mcpLifecycleLockPathExists(reaperPath))) {
      const token = crypto.randomUUID();
      const owner = createMcpLifecycleLockOwner(sandboxName, token);
      if (await writeMcpLifecycleLockCandidateAndLink(lockPath, owner)) {
        // A stale-lock reaper may have appeared between our pre-check and the
        // atomic link. Do not enter the critical section until that generation
        // gate has gone away.
        if (!(await mcpLifecycleLockPathExists(reaperPath))) return { lockPath, token };
        await safelyReleaseMcpLifecycleLock(lockPath, token);
      }
    }

    const observation = await readMcpLifecycleLockObservation(lockPath);
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
      await safelyReleaseMcpLifecycleLock(acquired.lockPath, acquired.token);
    }
  });
}
