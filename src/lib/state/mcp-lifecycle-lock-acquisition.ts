// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  decideMcpLifecycleAcquisition,
  decideMcpLifecycleLock,
  type CorruptGenerationState,
} from "./mcp-lifecycle-lock/decisions";
import {
  classifyMcpLifecycleLock,
  createMcpLifecycleLockOwner,
  type LockObservation,
} from "./mcp-lifecycle-lock-identity";
import {
  getMcpLifecycleLockPath,
  mcpLifecycleLockPathExists,
  mcpLifecycleLockPathExistsSync,
  readMcpLifecycleLockObservation,
  readMcpLifecycleLockObservationSync,
  reclaimStaleMcpLifecycleLockGeneration,
  reclaimStaleMcpLifecycleLockGenerationSync,
  safelyReleaseMcpLifecycleLock,
  safelyReleaseMcpLifecycleLockSync,
  writeMcpLifecycleLockCandidateAndLink,
  writeMcpLifecycleLockCandidateAndLinkSync,
  resolveNemoclawStateDir,
} from "./mcp-lifecycle-lock-storage";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CORRUPT_LOCK_GRACE_MS = 30_000;

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
  /** Monotonic clock override used by deterministic acquisition tests. */
  monotonicNow?: () => number;
}

interface HeldLockLease {
  active: boolean;
}

type HeldLockContext = ReadonlyMap<string, HeldLockLease>;

const heldLocks = new AsyncLocalStorage<HeldLockContext>();
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function decideObservedMcpLifecycleLock(
  observation: LockObservation,
  sandboxName: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationState,
  monotonicNow: number,
): ReturnType<typeof decideMcpLifecycleLock> {
  const ownerDisposition =
    observation.owner?.sandboxName === sandboxName
      ? classifyMcpLifecycleLock(observation, sandboxName, observation.mtimeMs, corruptLockGraceMs)
      : undefined;
  const decision = decideMcpLifecycleLock({
    observation,
    sandboxName,
    corruptLockGraceMs,
    corruptGeneration: corruptTracker,
    monotonicNow,
    ownerDisposition,
  });
  corruptTracker.generation = decision.corruptGeneration.generation;
  corruptTracker.firstSeenAt = decision.corruptGeneration.firstSeenAt;
  return decision;
}

function resetCorruptGenerationTracker(tracker: CorruptGenerationState): void {
  tracker.generation = null;
  tracker.firstSeenAt = 0;
}

function timeoutError(sandboxName: string, ownerPid: number | null): Error {
  const ownerSuffix = ownerPid ? ` (owner PID ${String(ownerPid)})` : "";
  return new Error(
    `Timed out waiting for the sandbox mutation lock for '${sandboxName}'${ownerSuffix}. Another lifecycle, policy, channel, inference, session, or snapshot operation is still running.`,
  );
}

async function tryReapStaleMainLock(
  lockPath: string,
  sandboxName: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationState,
  monotonicNow: () => number,
  assertBeforeTimeout: () => void,
): Promise<boolean> {
  const reaperPath = `${lockPath}.reaper`;
  const reaperToken = crypto.randomUUID();
  const reaperOwner = createMcpLifecycleLockOwner(sandboxName, reaperToken);
  assertBeforeTimeout();
  if (!(await writeMcpLifecycleLockCandidateAndLink(reaperPath, reaperOwner))) return false;
  try {
    assertBeforeTimeout();
    const latest = await readMcpLifecycleLockObservation(lockPath);
    if (!latest) return true;
    const decision = decideObservedMcpLifecycleLock(
      latest,
      sandboxName,
      corruptLockGraceMs,
      corruptTracker,
      monotonicNow(),
    );
    if (decision.kind !== "reap") return false;
    assertBeforeTimeout();
    return await reclaimStaleMcpLifecycleLockGeneration(lockPath, latest, assertBeforeTimeout);
  } finally {
    await safelyReleaseMcpLifecycleLock(reaperPath, reaperToken);
  }
}

function tryReapStaleMainLockSync(
  lockPath: string,
  sandboxName: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationState,
  monotonicNow: () => number,
  assertBeforeTimeout: () => void,
): boolean {
  const reaperPath = `${lockPath}.reaper`;
  const reaperToken = crypto.randomUUID();
  const reaperOwner = createMcpLifecycleLockOwner(sandboxName, reaperToken);
  assertBeforeTimeout();
  if (!writeMcpLifecycleLockCandidateAndLinkSync(reaperPath, reaperOwner)) return false;
  try {
    assertBeforeTimeout();
    const latest = readMcpLifecycleLockObservationSync(lockPath);
    if (!latest) return true;
    const decision = decideObservedMcpLifecycleLock(
      latest,
      sandboxName,
      corruptLockGraceMs,
      corruptTracker,
      monotonicNow(),
    );
    if (decision.kind !== "reap") return false;
    assertBeforeTimeout();
    return reclaimStaleMcpLifecycleLockGenerationSync(lockPath, latest, assertBeforeTimeout);
  } finally {
    safelyReleaseMcpLifecycleLockSync(reaperPath, reaperToken);
  }
}

async function acquireMcpLifecycleLock(
  sandboxName: string,
  options: McpLifecycleLockOptions & { stateDir: string },
): Promise<AcquiredMcpLifecycleLock> {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptLockGraceMs = positiveInteger(
    options.corruptLockGraceMs,
    DEFAULT_CORRUPT_LOCK_GRACE_MS,
  );
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const lockPath = getMcpLifecycleLockPath(sandboxName, options.stateDir);
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = monotonicNow() + timeoutMs;
  const corruptMainTracker: CorruptGenerationState = { generation: null, firstSeenAt: 0 };
  const corruptReaperTracker: CorruptGenerationState = { generation: null, firstSeenAt: 0 };
  let lastOwnerPid: number | null = null;
  const assertBeforeTimeout = () => {
    if (monotonicNow() >= deadline) throw timeoutError(sandboxName, lastOwnerPid);
  };

  for (;;) {
    assertBeforeTimeout();
    const reaperPath = `${lockPath}.reaper`;
    const reaperObservation = await readMcpLifecycleLockObservation(reaperPath);
    if (reaperObservation) {
      const reaperDecision = decideObservedMcpLifecycleLock(
        reaperObservation,
        sandboxName,
        corruptLockGraceMs,
        corruptReaperTracker,
        monotonicNow(),
      );
      const acquisitionDecision = decideMcpLifecycleAcquisition({
        phase: "reaper",
        lock: reaperDecision,
      });
      if (acquisitionDecision.kind === "reap") {
        assertBeforeTimeout();
        await reclaimStaleMcpLifecycleLockGeneration(
          reaperPath,
          reaperObservation,
          assertBeforeTimeout,
        );
        continue;
      }
      await sleep(pollIntervalMs);
      continue;
    }
    resetCorruptGenerationTracker(corruptReaperTracker);

    if (!(await mcpLifecycleLockPathExists(reaperPath))) {
      const token = crypto.randomUUID();
      const owner = createMcpLifecycleLockOwner(sandboxName, token);
      assertBeforeTimeout();
      if (await writeMcpLifecycleLockCandidateAndLink(lockPath, owner)) {
        const published = await readMcpLifecycleLockObservation(lockPath);
        const publicationDecision = decideMcpLifecycleAcquisition({
          phase: "published",
          reaperPresent: await mcpLifecycleLockPathExists(reaperPath),
          expectedOwnerToken: token,
          observedOwnerToken: published?.owner?.token,
        });
        if (publicationDecision.kind === "enter") {
          try {
            assertBeforeTimeout();
          } catch (error) {
            await safelyReleaseMcpLifecycleLock(lockPath, token);
            throw error;
          }
          return { lockPath, token };
        }
        await safelyReleaseMcpLifecycleLock(lockPath, token);
      }
    }

    const observation = await readMcpLifecycleLockObservation(lockPath);
    if (observation) {
      lastOwnerPid = observation.owner?.pid ?? null;
      const mainDecision = decideObservedMcpLifecycleLock(
        observation,
        sandboxName,
        corruptLockGraceMs,
        corruptMainTracker,
        monotonicNow(),
      );
      if (
        decideMcpLifecycleAcquisition({ phase: "main-owner", lock: mainDecision }).kind === "reap"
      ) {
        await tryReapStaleMainLock(
          lockPath,
          sandboxName,
          corruptLockGraceMs,
          corruptMainTracker,
          monotonicNow,
          assertBeforeTimeout,
        );
        continue;
      }
    } else {
      lastOwnerPid = null;
      resetCorruptGenerationTracker(corruptMainTracker);
    }
    await sleep(pollIntervalMs);
  }
}

function acquireMcpLifecycleLockSync(
  sandboxName: string,
  options: McpLifecycleLockOptions & { stateDir: string },
): AcquiredMcpLifecycleLock {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptLockGraceMs = positiveInteger(
    options.corruptLockGraceMs,
    DEFAULT_CORRUPT_LOCK_GRACE_MS,
  );
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const lockPath = getMcpLifecycleLockPath(sandboxName, options.stateDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = monotonicNow() + timeoutMs;
  const corruptMainTracker: CorruptGenerationState = { generation: null, firstSeenAt: 0 };
  const corruptReaperTracker: CorruptGenerationState = { generation: null, firstSeenAt: 0 };
  let lastOwnerPid: number | null = null;
  const assertBeforeTimeout = () => {
    if (monotonicNow() >= deadline) throw timeoutError(sandboxName, lastOwnerPid);
  };

  for (;;) {
    assertBeforeTimeout();
    const reaperPath = `${lockPath}.reaper`;
    const reaperObservation = readMcpLifecycleLockObservationSync(reaperPath);
    if (reaperObservation) {
      const reaperDecision = decideObservedMcpLifecycleLock(
        reaperObservation,
        sandboxName,
        corruptLockGraceMs,
        corruptReaperTracker,
        monotonicNow(),
      );
      const acquisitionDecision = decideMcpLifecycleAcquisition({
        phase: "reaper",
        lock: reaperDecision,
      });
      if (acquisitionDecision.kind === "reap") {
        assertBeforeTimeout();
        reclaimStaleMcpLifecycleLockGenerationSync(
          reaperPath,
          reaperObservation,
          assertBeforeTimeout,
        );
        continue;
      }
      sleepSync(pollIntervalMs);
      continue;
    }
    resetCorruptGenerationTracker(corruptReaperTracker);

    if (!mcpLifecycleLockPathExistsSync(reaperPath)) {
      const token = crypto.randomUUID();
      const owner = createMcpLifecycleLockOwner(sandboxName, token);
      assertBeforeTimeout();
      if (writeMcpLifecycleLockCandidateAndLinkSync(lockPath, owner)) {
        const published = readMcpLifecycleLockObservationSync(lockPath);
        const publicationDecision = decideMcpLifecycleAcquisition({
          phase: "published",
          reaperPresent: mcpLifecycleLockPathExistsSync(reaperPath),
          expectedOwnerToken: token,
          observedOwnerToken: published?.owner?.token,
        });
        if (publicationDecision.kind === "enter") {
          try {
            assertBeforeTimeout();
          } catch (error) {
            safelyReleaseMcpLifecycleLockSync(lockPath, token);
            throw error;
          }
          return { lockPath, token };
        }
        safelyReleaseMcpLifecycleLockSync(lockPath, token);
      }
    }

    const observation = readMcpLifecycleLockObservationSync(lockPath);
    if (observation) {
      lastOwnerPid = observation.owner?.pid ?? null;
      const mainDecision = decideObservedMcpLifecycleLock(
        observation,
        sandboxName,
        corruptLockGraceMs,
        corruptMainTracker,
        monotonicNow(),
      );
      if (
        decideMcpLifecycleAcquisition({ phase: "main-owner", lock: mainDecision }).kind === "reap"
      ) {
        tryReapStaleMainLockSync(
          lockPath,
          sandboxName,
          corruptLockGraceMs,
          corruptMainTracker,
          monotonicNow,
          assertBeforeTimeout,
        );
        continue;
      }
    } else {
      lastOwnerPid = null;
      resetCorruptGenerationTracker(corruptMainTracker);
    }
    sleepSync(pollIntervalMs);
  }
}

export function isMcpLifecycleLockHeld(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): boolean {
  return heldLocks.getStore()?.get(getMcpLifecycleLockPath(sandboxName, stateDir))?.active === true;
}

export function withMcpLifecycleLockSync<T>(
  sandboxName: string,
  operation: () => T,
  options: McpLifecycleLockOptions = {},
): T {
  const stateDir = options.stateDir ?? resolveNemoclawStateDir();
  const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
  const inherited = heldLocks.getStore();
  if (inherited?.get(lockPath)?.active) return operation();

  const acquired = acquireMcpLifecycleLockSync(sandboxName, { ...options, stateDir });
  const lease: HeldLockLease = { active: true };
  const context = new Map(inherited ?? []);
  context.set(lockPath, lease);
  try {
    return heldLocks.run(context, operation);
  } finally {
    lease.active = false;
    safelyReleaseMcpLifecycleLockSync(acquired.lockPath, acquired.token);
  }
}

/** Serialize one sandbox mutation across processes. */
export async function withMcpLifecycleLock<T>(
  sandboxName: string,
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  const stateDir = options.stateDir ?? resolveNemoclawStateDir();
  const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
  const inherited = heldLocks.getStore();
  if (inherited?.get(lockPath)?.active) return await operation();

  const acquired = await acquireMcpLifecycleLock(sandboxName, { ...options, stateDir });
  const lease: HeldLockLease = { active: true };
  const context = new Map(inherited ?? []);
  context.set(lockPath, lease);
  return heldLocks.run(context, async () => {
    try {
      return await operation();
    } finally {
      lease.active = false;
      await safelyReleaseMcpLifecycleLock(acquired.lockPath, acquired.token);
    }
  });
}
