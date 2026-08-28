// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  isShieldsTimerDeadlineExpired,
  readShieldsTimerTakeoverToken,
} from "./mcp-lifecycle-lock/shields-timer-authority";
import {
  decideMcpLifecycleAcquisition,
  decideMcpLifecycleLock,
  type CorruptGenerationState,
} from "./mcp-lifecycle-lock/decisions";
import {
  classifyMcpLifecycleLock,
  createMcpLifecycleLockOwner,
  type LockObservation,
  type McpLifecycleLockOwner,
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
  readMcpLockProcessIdentity,
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
} from "./mcp-lifecycle-lock-storage";
import { resolveNemoclawStateDir } from "./paths";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CORRUPT_LOCK_GRACE_MS = 30_000;

type CorruptGenerationTracker = CorruptGenerationState;

interface AcquiredMcpLifecycleLock {
  lockPath: string;
  token: string;
  shieldsTakeoverToken?: string;
}

export interface McpLifecycleDeadlineFenceOptions extends McpLifecycleLockOptions {
  /** Audit an owner that keeps the deadline gate closed while it exits naturally. */
  onContainment?: (details: McpLifecycleDeadlineContainment) => Promise<void> | void;
  /** Account for a recoverable deadline acquisition or main-publication failure. */
  onSetupFailure?: (error: unknown) => Promise<void> | void;
  /** Return operator guidance instead of waiting when durable containment already exists. */
  throwOnCommittedContainment?: boolean;
  /** Run synchronously after this fence's exact main and deadline generations are released. */
  onReleased?: () => void;
}

export interface McpLifecycleDeadlineFenceSyncOptions extends McpLifecycleLockOptions {
  /** Audit an owner that keeps the deadline gate closed while it exits naturally. */
  onContainment?: (details: McpLifecycleDeadlineContainment) => void;
  /** Return operator guidance instead of waiting when durable containment already exists. */
  throwOnCommittedContainment?: boolean;
}

export interface McpLifecycleDeadlineContainment {
  kind: "verified-live-wait" | "failure";
  ownerPid: number | null;
  reason: string;
}

export interface McpLifecycleLockOptions {
  /** Override used by focused tests. Production callers use ~/.nemoclaw/state. */
  stateDir?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  corruptLockGraceMs?: number;
  /** Monotonic clock override used only by deterministic deadline tests. */
  monotonicNow?: () => number;
}

interface HeldLockLease {
  active: boolean;
  retainForDurableContainment: boolean;
}

type HeldLockContext = ReadonlyMap<string, HeldLockLease>;

const heldLocks = new AsyncLocalStorage<HeldLockContext>();

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function committedContainmentPath(lockPath: string): string {
  return `${lockPath}.containment`;
}

function fsyncLockDirectorySync(lockPath: string): void {
  const directoryFd = fs.openSync(path.dirname(lockPath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function beginCommittedContainmentAtPathSync(
  lockPath: string,
  sandboxName: string,
  takeoverToken: string | undefined,
  reason: string,
  assertAuthority?: () => void,
): void {
  const containmentPath = committedContainmentPath(lockPath);
  const token = crypto.randomUUID();
  const owner = {
    ...createMcpLifecycleLockOwner(sandboxName, token, takeoverToken),
    containmentReason: reason,
  };
  assertAuthority?.();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (!writeMcpLifecycleLockCandidateAndLinkSync(containmentPath, owner)) {
    throw new Error(
      `A committed process-tree containment already exists for sandbox '${sandboxName}'`,
    );
  }
  try {
    fsyncLockDirectorySync(containmentPath);
    assertAuthority?.();
  } catch (error) {
    let rolledBack = false;
    try {
      const published = readMcpLifecycleLockObservationSync(containmentPath);
      if (published?.owner?.token === token) {
        rolledBack = reclaimStaleMcpLifecycleLockGenerationSync(containmentPath, published);
        if (rolledBack) fsyncLockDirectorySync(containmentPath);
      }
    } catch {
      rolledBack = false;
    }
    if (!rolledBack) {
      throw durableMcpLifecycleContainmentFailure(
        new Error(
          `Containment publication for sandbox '${sandboxName}' lost authority or durability, and its exact generation could not be rolled back`,
        ),
        lockPath,
        { retainOwnedLifecycleGates: true },
      );
    }
    throw error;
  }
}

function ensureDurableContainmentForStaleGenerationSync(
  lockPath: string,
  sandboxName: string,
  stateDir: string,
  observation: LockObservation,
  reason: string,
  assertAuthority?: () => void,
): void {
  const containmentPath = committedContainmentPath(lockPath);
  if (mcpLifecycleLockPathExistsSync(containmentPath)) return;
  const generation = `${String(observation.dev)}:${String(observation.ino)}:${
    observation.owner?.token ?? "invalid"
  }`;
  try {
    beginCommittedContainmentAtPathSync(
      lockPath,
      sandboxName,
      readShieldsTimerTakeoverToken(sandboxName, stateDir),
      `${reason}; contained generation ${generation}`,
      assertAuthority,
    );
  } catch (error) {
    if (mcpLifecycleLockPathExistsSync(containmentPath)) return;
    throw error;
  }
}

export function beginCommittedMcpLifecycleContainmentSync(
  sandboxName: string,
  takeoverToken: string,
  reason: string,
  stateDir = resolveNemoclawStateDir(),
  assertAuthority?: () => void,
): void {
  if (!/^[0-9a-f]{32}$/.test(takeoverToken)) {
    throw new Error("Auto-restore takeover token must be 32 lowercase hexadecimal characters");
  }
  beginCommittedContainmentAtPathSync(
    getMcpLifecycleLockPath(sandboxName, stateDir),
    sandboxName,
    takeoverToken,
    reason,
    assertAuthority,
  );
}

function decideObservedMcpLifecycleLock(
  observation: LockObservation,
  role: "main" | "reaper" | "deadline",
  sandboxName: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationTracker,
  now: number,
): ReturnType<typeof decideMcpLifecycleLock> {
  const ownerDisposition =
    observation.owner?.sandboxName === sandboxName
      ? classifyMcpLifecycleLock(observation, sandboxName, observation.mtimeMs, corruptLockGraceMs)
      : undefined;
  const decision = decideMcpLifecycleLock({
    role,
    observation,
    sandboxName,
    corruptLockGraceMs,
    corruptGeneration: corruptTracker,
    monotonicNow: now,
    ownerDisposition,
  });
  corruptTracker.generation = decision.corruptGeneration.generation;
  corruptTracker.firstSeenAt = decision.corruptGeneration.firstSeenAt;
  return decision;
}

function resetCorruptGenerationTracker(tracker: CorruptGenerationTracker): void {
  tracker.generation = null;
  tracker.firstSeenAt = 0;
}

function committedContainmentActiveError(
  sandboxName: string,
  lockPath: string,
  containment: LockObservation,
): Error {
  const containmentPath = committedContainmentPath(lockPath);
  return new Error(
    `Sandbox mutation containment is active for '${sandboxName}' at '${containmentPath}' (generation token '${containment.owner?.token ?? "invalid"}'). A previous owner or stale-lock reaper exited without proof that every descendant stopped. Stop all NemoClaw processes for this sandbox; inspect '${lockPath}', '${lockPath}.reaper', and '${lockPath}.deadline'; record each target's file kind, device/inode, and owner token when present; verify those identities and this containment token are unchanged; remove only those exact stale owner generations first and this exact containment generation last before retrying.`,
  );
}

async function tryReapStaleMainLock(
  lockPath: string,
  sandboxName: string,
  stateDir: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationTracker,
  monotonicNow: () => number,
  assertBeforeDeadline: () => void,
): Promise<boolean> {
  const containmentPath = committedContainmentPath(lockPath);
  const deadlinePath = `${lockPath}.deadline`;
  if (
    (await mcpLifecycleLockPathExists(containmentPath)) ||
    (await mcpLifecycleLockPathExists(deadlinePath))
  ) {
    return false;
  }

  const takeoverToken = readShieldsTimerTakeoverToken(sandboxName, stateDir);
  const reaperPath = `${lockPath}.reaper`;
  const reaperToken = crypto.randomUUID();
  const reaperOwner = createMcpLifecycleLockOwner(sandboxName, reaperToken, takeoverToken);
  assertBeforeDeadline();
  if (!(await writeMcpLifecycleLockCandidateAndLink(reaperPath, reaperOwner))) return false;

  try {
    assertBeforeDeadline();
    if (
      (await mcpLifecycleLockPathExists(containmentPath)) ||
      (await mcpLifecycleLockPathExists(deadlinePath)) ||
      readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken
    ) {
      return false;
    }
    const latest = await readMcpLifecycleLockObservation(lockPath);
    if (!latest) return true;
    const decision = decideObservedMcpLifecycleLock(
      latest,
      "main",
      sandboxName,
      corruptLockGraceMs,
      corruptTracker,
      monotonicNow(),
    );
    if (decision.kind !== "reap") {
      return false;
    }
    const currentTakeoverToken = readShieldsTimerTakeoverToken(sandboxName, stateDir);
    if (currentTakeoverToken !== takeoverToken) {
      // Shields-down acquires the main generation before publishing its timer
      // marker. Never reclaim across that authority transition; a subsequent
      // reaper will inspect the generation under the now-current token.
      return false;
    }
    if (decision.timerBound || currentTakeoverToken) {
      assertBeforeDeadline();
      ensureDurableContainmentForStaleGenerationSync(
        lockPath,
        sandboxName,
        stateDir,
        latest,
        "A timer-bound sandbox mutation owner exited before durable containment was committed",
        assertBeforeDeadline,
      );
      return false;
    }
    assertBeforeDeadline();
    // Await reclamation so the finally block releases the reaper generation after reclamation or restoration completes.
    return await reclaimStaleMcpLifecycleLockGeneration(lockPath, latest, assertBeforeDeadline);
  } finally {
    await safelyReleaseMcpLifecycleLock(reaperPath, reaperToken);
  }
}

function tryReapStaleMainLockSync(
  lockPath: string,
  sandboxName: string,
  stateDir: string,
  corruptLockGraceMs: number,
  corruptTracker: CorruptGenerationTracker,
  monotonicNow: () => number,
  assertBeforeDeadline: () => void,
): boolean {
  const containmentPath = committedContainmentPath(lockPath);
  const deadlinePath = `${lockPath}.deadline`;
  if (
    mcpLifecycleLockPathExistsSync(containmentPath) ||
    mcpLifecycleLockPathExistsSync(deadlinePath)
  ) {
    return false;
  }

  const takeoverToken = readShieldsTimerTakeoverToken(sandboxName, stateDir);
  const reaperPath = `${lockPath}.reaper`;
  const reaperToken = crypto.randomUUID();
  const reaperOwner = createMcpLifecycleLockOwner(sandboxName, reaperToken, takeoverToken);
  assertBeforeDeadline();
  if (!writeMcpLifecycleLockCandidateAndLinkSync(reaperPath, reaperOwner)) return false;

  try {
    assertBeforeDeadline();
    if (
      mcpLifecycleLockPathExistsSync(containmentPath) ||
      mcpLifecycleLockPathExistsSync(deadlinePath) ||
      readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken
    ) {
      return false;
    }
    const latest = readMcpLifecycleLockObservationSync(lockPath);
    if (!latest) return true;
    const decision = decideObservedMcpLifecycleLock(
      latest,
      "main",
      sandboxName,
      corruptLockGraceMs,
      corruptTracker,
      monotonicNow(),
    );
    if (decision.kind !== "reap") {
      return false;
    }
    const currentTakeoverToken = readShieldsTimerTakeoverToken(sandboxName, stateDir);
    if (currentTakeoverToken !== takeoverToken) {
      // Shields-down acquires the main generation before publishing its timer
      // marker. Never reclaim across that authority transition; a subsequent
      // reaper will inspect the generation under the now-current token.
      return false;
    }
    if (decision.timerBound || currentTakeoverToken) {
      assertBeforeDeadline();
      ensureDurableContainmentForStaleGenerationSync(
        lockPath,
        sandboxName,
        stateDir,
        latest,
        "A timer-bound sandbox mutation owner exited before durable containment was committed",
        assertBeforeDeadline,
      );
      return false;
    }
    assertBeforeDeadline();
    return reclaimStaleMcpLifecycleLockGenerationSync(lockPath, latest, assertBeforeDeadline);
  } finally {
    safelyReleaseMcpLifecycleLockSync(reaperPath, reaperToken);
  }
}

async function acquireMcpLifecycleLock(
  sandboxName: string,
  options: McpLifecycleLockOptions,
): Promise<AcquiredMcpLifecycleLock & { assertBeforeDeadline: () => void }> {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptLockGraceMs = positiveInteger(
    options.corruptLockGraceMs,
    DEFAULT_CORRUPT_LOCK_GRACE_MS,
  );
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const stateDir = options.stateDir ?? resolveNemoclawStateDir();
  const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
  await fs.promises.mkdir(path.dirname(lockPath), {
    recursive: true,
    mode: 0o700,
  });

  const deadline = monotonicNow() + timeoutMs;
  const corruptMainTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  const corruptReaperTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  const corruptDeadlineTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  let lastOwnerPid: number | null = null;
  const assertBeforeDeadline = () => {
    if (monotonicNow() < deadline) return;
    const ownerSuffix = lastOwnerPid ? ` (owner pid ${lastOwnerPid})` : "";
    throw new Error(
      `Timed out waiting for the sandbox mutation lock for '${sandboxName}'${ownerSuffix}. Another lifecycle, policy, channel, shields, or snapshot operation is still running.`,
    );
  };
  for (;;) {
    const containmentPath = committedContainmentPath(lockPath);
    const containment = await readMcpLifecycleLockObservation(containmentPath);
    const containmentDecision = decideMcpLifecycleAcquisition({
      phase: "containment",
      observation: containment,
    });
    if (containmentDecision.kind === "refuse") {
      throw committedContainmentActiveError(sandboxName, lockPath, containmentDecision.containment);
    }
    assertBeforeDeadline();

    const deadlinePath = `${lockPath}.deadline`;
    const deadlineObservation = await readMcpLifecycleLockObservation(deadlinePath);
    if (deadlineObservation) {
      const deadlineDecision = decideObservedMcpLifecycleLock(
        deadlineObservation,
        "deadline",
        sandboxName,
        corruptLockGraceMs,
        corruptDeadlineTracker,
        monotonicNow(),
      );
      const acquisitionDecision = decideMcpLifecycleAcquisition({
        phase: "deadline",
        lock: deadlineDecision,
      });
      if (acquisitionDecision.kind === "contain") {
        assertBeforeDeadline();
        ensureDurableContainmentForStaleGenerationSync(
          lockPath,
          sandboxName,
          stateDir,
          deadlineObservation,
          "An auto-restore deadline owner exited before its recovery operation completed",
          assertBeforeDeadline,
        );
        continue;
      }
      await sleep(pollIntervalMs);
      continue;
    }
    resetCorruptGenerationTracker(corruptDeadlineTracker);

    const reaperPath = `${lockPath}.reaper`;
    const reaperObservation = await readMcpLifecycleLockObservation(reaperPath);
    if (reaperObservation) {
      const reaperDecision = decideObservedMcpLifecycleLock(
        reaperObservation,
        "reaper",
        sandboxName,
        corruptLockGraceMs,
        corruptReaperTracker,
        monotonicNow(),
      );
      const acquisitionDecision = decideMcpLifecycleAcquisition({
        phase: "reaper",
        lock: reaperDecision,
      });
      if (acquisitionDecision.kind === "contain") {
        assertBeforeDeadline();
        ensureDurableContainmentForStaleGenerationSync(
          lockPath,
          sandboxName,
          stateDir,
          reaperObservation,
          "A stale-lock reaper exited before cleanup completed",
          assertBeforeDeadline,
        );
        continue;
      }
      await sleep(pollIntervalMs);
      continue;
    }
    resetCorruptGenerationTracker(corruptReaperTracker);

    // The detached timer publishes its deadline fence only after restoreAt.
    // Close the ordinary-acquisition gate directly from the durable marker so
    // no new top-level mutation can enter in that publication window, or if
    // the timer exits before it publishes the fence. Timer/interactive
    // recovery uses the dedicated deadline-fence API and does not pass here.
    if (
      decideMcpLifecycleAcquisition({
        phase: "timer",
        deadlineExpired: isShieldsTimerDeadlineExpired(sandboxName, stateDir),
      }).kind === "wait"
    ) {
      await sleep(pollIntervalMs);
      continue;
    }

    if (
      !(await mcpLifecycleLockPathExists(deadlinePath)) &&
      !(await mcpLifecycleLockPathExists(reaperPath)) &&
      !isShieldsTimerDeadlineExpired(sandboxName, stateDir)
    ) {
      const token = crypto.randomUUID();
      const shieldsTakeoverToken = readShieldsTimerTakeoverToken(sandboxName, stateDir);
      const owner = createMcpLifecycleLockOwner(sandboxName, token, shieldsTakeoverToken);
      assertBeforeDeadline();
      if (await writeMcpLifecycleLockCandidateAndLink(lockPath, owner)) {
        // A stale-lock reaper may have appeared between our pre-check and the
        // atomic link. Do not enter the critical section until that generation
        // gate has gone away.
        const publishedObservation = await readMcpLifecycleLockObservation(lockPath);
        const publicationDecision = decideMcpLifecycleAcquisition({
          phase: "published",
          containmentPresent: await mcpLifecycleLockPathExists(containmentPath),
          deadlinePresent: await mcpLifecycleLockPathExists(deadlinePath),
          reaperPresent: await mcpLifecycleLockPathExists(reaperPath),
          timerDeadlineExpired: isShieldsTimerDeadlineExpired(sandboxName, stateDir),
          expectedOwnerToken: token,
          observedOwnerToken: publishedObservation?.owner?.token,
          expectedTakeoverToken: shieldsTakeoverToken,
          observedTakeoverToken: readShieldsTimerTakeoverToken(sandboxName, stateDir),
        });
        if (publicationDecision.kind === "enter") {
          try {
            assertBeforeDeadline();
          } catch (error) {
            await safelyReleaseMcpLifecycleLock(lockPath, token);
            throw error;
          }
          return {
            lockPath,
            token,
            assertBeforeDeadline,
            ...(shieldsTakeoverToken ? { shieldsTakeoverToken } : {}),
          };
        }
        await safelyReleaseMcpLifecycleLock(lockPath, token);
      }
    }

    const observation = await readMcpLifecycleLockObservation(lockPath);
    if (observation) {
      lastOwnerPid = observation.owner?.pid ?? null;
      const mainDecision = decideObservedMcpLifecycleLock(
        observation,
        "main",
        sandboxName,
        corruptLockGraceMs,
        corruptMainTracker,
        monotonicNow(),
      );
      const acquisitionDecision = decideMcpLifecycleAcquisition({
        phase: "main-owner",
        lock: mainDecision,
      });
      if (acquisitionDecision.kind === "reap" || acquisitionDecision.kind === "contain") {
        if (acquisitionDecision.kind === "reap") {
          assertBeforeDeadline();
          await tryReapStaleMainLock(
            lockPath,
            sandboxName,
            stateDir,
            corruptLockGraceMs,
            corruptMainTracker,
            monotonicNow,
            assertBeforeDeadline,
          );
          continue;
        }
        assertBeforeDeadline();
        ensureDurableContainmentForStaleGenerationSync(
          lockPath,
          sandboxName,
          stateDir,
          observation,
          "A sandbox mutation owner exited before its descendants could be proven contained",
          assertBeforeDeadline,
        );
        continue;
      }
    } else {
      resetCorruptGenerationTracker(corruptMainTracker);
    }
    await sleep(pollIntervalMs);
  }
}

function acquireMcpLifecycleLockSync(
  sandboxName: string,
  options: McpLifecycleLockOptions & { stateDir: string },
): AcquiredMcpLifecycleLock & { assertBeforeDeadline: () => void } {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptLockGraceMs = positiveInteger(
    options.corruptLockGraceMs,
    DEFAULT_CORRUPT_LOCK_GRACE_MS,
  );
  const lockPath = getMcpLifecycleLockPath(sandboxName, options.stateDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const deadline = monotonicNow() + timeoutMs;
  const corruptMainTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  const corruptReaperTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  const corruptDeadlineTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  let lastOwnerPid: number | null = null;
  const assertBeforeDeadline = () => {
    if (monotonicNow() < deadline) return;
    throw new Error(
      `Timed out waiting for sandbox mutation lock for '${sandboxName}'${
        lastOwnerPid ? ` (owner PID ${lastOwnerPid})` : ""
      }`,
    );
  };
  for (;;) {
    const containmentPath = committedContainmentPath(lockPath);
    const containment = readMcpLifecycleLockObservationSync(containmentPath);
    const containmentDecision = decideMcpLifecycleAcquisition({
      phase: "containment",
      observation: containment,
    });
    if (containmentDecision.kind === "refuse") {
      throw committedContainmentActiveError(sandboxName, lockPath, containmentDecision.containment);
    }
    assertBeforeDeadline();

    const deadlinePath = `${lockPath}.deadline`;
    const deadlineObservation = readMcpLifecycleLockObservationSync(deadlinePath);
    if (deadlineObservation) {
      const deadlineDecision = decideObservedMcpLifecycleLock(
        deadlineObservation,
        "deadline",
        sandboxName,
        corruptLockGraceMs,
        corruptDeadlineTracker,
        monotonicNow(),
      );
      const acquisitionDecision = decideMcpLifecycleAcquisition({
        phase: "deadline",
        lock: deadlineDecision,
      });
      if (acquisitionDecision.kind === "contain") {
        assertBeforeDeadline();
        ensureDurableContainmentForStaleGenerationSync(
          lockPath,
          sandboxName,
          options.stateDir,
          deadlineObservation,
          "An auto-restore deadline owner exited before its recovery operation completed",
          assertBeforeDeadline,
        );
        continue;
      }
      sleepSync(pollIntervalMs);
      continue;
    }
    resetCorruptGenerationTracker(corruptDeadlineTracker);

    const reaperPath = `${lockPath}.reaper`;
    const reaperObservation = readMcpLifecycleLockObservationSync(reaperPath);
    if (reaperObservation) {
      const reaperDecision = decideObservedMcpLifecycleLock(
        reaperObservation,
        "reaper",
        sandboxName,
        corruptLockGraceMs,
        corruptReaperTracker,
        monotonicNow(),
      );
      const acquisitionDecision = decideMcpLifecycleAcquisition({
        phase: "reaper",
        lock: reaperDecision,
      });
      if (acquisitionDecision.kind === "contain") {
        assertBeforeDeadline();
        ensureDurableContainmentForStaleGenerationSync(
          lockPath,
          sandboxName,
          options.stateDir,
          reaperObservation,
          "A stale-lock reaper exited before cleanup completed",
          assertBeforeDeadline,
        );
        continue;
      }
      sleepSync(pollIntervalMs);
      continue;
    }
    resetCorruptGenerationTracker(corruptReaperTracker);

    if (
      decideMcpLifecycleAcquisition({
        phase: "timer",
        deadlineExpired: isShieldsTimerDeadlineExpired(sandboxName, options.stateDir),
      }).kind === "wait"
    ) {
      sleepSync(pollIntervalMs);
      continue;
    }

    if (
      !mcpLifecycleLockPathExistsSync(deadlinePath) &&
      !mcpLifecycleLockPathExistsSync(reaperPath) &&
      !isShieldsTimerDeadlineExpired(sandboxName, options.stateDir)
    ) {
      const token = crypto.randomUUID();
      const shieldsTakeoverToken = readShieldsTimerTakeoverToken(sandboxName, options.stateDir);
      const owner = createMcpLifecycleLockOwner(sandboxName, token, shieldsTakeoverToken);
      assertBeforeDeadline();
      if (writeMcpLifecycleLockCandidateAndLinkSync(lockPath, owner)) {
        const publishedObservation = readMcpLifecycleLockObservationSync(lockPath);
        const publicationDecision = decideMcpLifecycleAcquisition({
          phase: "published",
          containmentPresent: mcpLifecycleLockPathExistsSync(containmentPath),
          deadlinePresent: mcpLifecycleLockPathExistsSync(deadlinePath),
          reaperPresent: mcpLifecycleLockPathExistsSync(reaperPath),
          timerDeadlineExpired: isShieldsTimerDeadlineExpired(sandboxName, options.stateDir),
          expectedOwnerToken: token,
          observedOwnerToken: publishedObservation?.owner?.token,
          expectedTakeoverToken: shieldsTakeoverToken,
          observedTakeoverToken: readShieldsTimerTakeoverToken(sandboxName, options.stateDir),
        });
        if (publicationDecision.kind === "enter") {
          try {
            assertBeforeDeadline();
          } catch (error) {
            safelyReleaseMcpLifecycleLockSync(lockPath, token);
            throw error;
          }
          return {
            lockPath,
            token,
            assertBeforeDeadline,
            ...(shieldsTakeoverToken ? { shieldsTakeoverToken } : {}),
          };
        }
        safelyReleaseMcpLifecycleLockSync(lockPath, token);
      }
    }

    const observation = readMcpLifecycleLockObservationSync(lockPath);
    if (observation) {
      lastOwnerPid = observation.owner?.pid ?? null;
      const mainDecision = decideObservedMcpLifecycleLock(
        observation,
        "main",
        sandboxName,
        corruptLockGraceMs,
        corruptMainTracker,
        monotonicNow(),
      );
      const acquisitionDecision = decideMcpLifecycleAcquisition({
        phase: "main-owner",
        lock: mainDecision,
      });
      if (acquisitionDecision.kind === "reap" || acquisitionDecision.kind === "contain") {
        if (acquisitionDecision.kind === "reap") {
          assertBeforeDeadline();
          tryReapStaleMainLockSync(
            lockPath,
            sandboxName,
            options.stateDir,
            corruptLockGraceMs,
            corruptMainTracker,
            monotonicNow,
            assertBeforeDeadline,
          );
          continue;
        }
        assertBeforeDeadline();
        ensureDurableContainmentForStaleGenerationSync(
          lockPath,
          sandboxName,
          options.stateDir,
          observation,
          "A sandbox mutation owner exited before its descendants could be proven contained",
          assertBeforeDeadline,
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

function sameLockGeneration(left: LockObservation, right: LockObservation | null): boolean {
  if (!right || left.dev !== right.dev || left.ino !== right.ino) return false;
  const leftToken = left.owner?.token;
  const rightToken = right.owner?.token;
  return leftToken === rightToken;
}

function selfOwnedDeadlineMainToken(
  observation: LockObservation | null,
  sandboxName: string,
  takeoverToken: string,
  expectedToken: string,
): string | null {
  const owner = observation?.owner;
  const processIdentity = readMcpLockProcessIdentity(process.pid);
  return owner?.sandboxName === sandboxName &&
    owner.pid === process.pid &&
    Boolean(processIdentity) &&
    owner.processIdentity === processIdentity &&
    owner.hostIdentity === readMcpLockHostIdentity() &&
    owner.pidNamespaceIdentity === readMcpLockPidNamespaceIdentity() &&
    owner.shieldsTakeoverToken === takeoverToken &&
    owner.token === expectedToken
    ? owner.token
    : null;
}

function isDurableContainmentError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === "NEMOCLAW_DURABLE_CONTAINMENT"
  );
}

function durableContainmentMustRetainOwnedLifecycleGates(error: unknown): boolean {
  return (
    isDurableContainmentError(error) &&
    (error as Error & { retainOwnedLifecycleGates?: boolean }).retainOwnedLifecycleGates === true
  );
}

export function durableMcpLifecycleContainmentFailure(
  error: unknown,
  lockPath: string,
  options: { retainOwnedLifecycleGates?: boolean } = {},
): Error & { code: string; retainOwnedLifecycleGates?: boolean } {
  const lease = heldLocks.getStore()?.get(lockPath);
  if (lease?.active) lease.retainForDurableContainment = true;
  if (isDurableContainmentError(error)) {
    const failure = error as Error & { code: string; retainOwnedLifecycleGates?: boolean };
    if (options.retainOwnedLifecycleGates) failure.retainOwnedLifecycleGates = true;
    return failure;
  }
  const failure = new Error(
    `Durable sandbox mutation containment requires operator resolution: ${
      error instanceof Error ? error.message : String(error)
    }`,
  ) as Error & { code: string; retainOwnedLifecycleGates?: boolean };
  failure.code = "NEMOCLAW_DURABLE_CONTAINMENT";
  if (options.retainOwnedLifecycleGates) failure.retainOwnedLifecycleGates = true;
  return failure;
}

async function ownedLifecycleGateMustRemainClosed(lockPath: string): Promise<boolean> {
  try {
    return !(await mcpLifecycleLockPathExists(committedContainmentPath(lockPath)));
  } catch {
    // If committed containment cannot be inspected, retaining the exact owned
    // generation is the only fail-closed outcome.
    return true;
  }
}

function ownedLifecycleGateMustRemainClosedSync(lockPath: string): boolean {
  try {
    return !mcpLifecycleLockPathExistsSync(committedContainmentPath(lockPath));
  } catch {
    // If committed containment cannot be inspected, retaining the exact
    // owned generation is the only fail-closed outcome.
    return true;
  }
}

async function retainOwnedLifecycleGateAfterFailure(
  error: unknown,
  lockPath: string,
): Promise<boolean> {
  if (!isDurableContainmentError(error)) return false;
  if (durableContainmentMustRetainOwnedLifecycleGates(error)) return true;
  return await ownedLifecycleGateMustRemainClosed(lockPath);
}

function retainOwnedLifecycleGateAfterFailureSync(error: unknown, lockPath: string): boolean {
  if (!isDurableContainmentError(error)) return false;
  if (durableContainmentMustRetainOwnedLifecycleGates(error)) return true;
  return ownedLifecycleGateMustRemainClosedSync(lockPath);
}

async function deadlineMainStillPresent(lockPath: string): Promise<boolean> {
  try {
    return (await readMcpLifecycleLockObservation(lockPath)) !== null;
  } catch {
    return true;
  }
}

function deadlineMainStillPresentSync(lockPath: string): boolean {
  try {
    return readMcpLifecycleLockObservationSync(lockPath) !== null;
  } catch {
    return true;
  }
}

async function reportDeadlineContainment(
  options: McpLifecycleDeadlineFenceOptions,
  details: McpLifecycleDeadlineContainment,
): Promise<void> {
  try {
    await options.onContainment?.(details);
  } catch {
    // Reporting must not release the security gate it is describing.
  }
}

function reportDeadlineContainmentSync(
  options: McpLifecycleDeadlineFenceSyncOptions,
  details: McpLifecycleDeadlineContainment,
): void {
  try {
    options.onContainment?.(details);
  } catch {
    // Reporting must not release the security gate it is describing.
  }
}

async function acquireDeadlineFence(
  sandboxName: string,
  takeoverToken: string,
  options: McpLifecycleDeadlineFenceOptions,
): Promise<AcquiredMcpLifecycleLock> {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptLockGraceMs = positiveInteger(
    options.corruptLockGraceMs,
    DEFAULT_CORRUPT_LOCK_GRACE_MS,
  );
  const lockPath = getMcpLifecycleLockPath(sandboxName, options.stateDir);
  const deadlinePath = `${lockPath}.deadline`;
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  let blockedAt = performance.now();
  let notifiedGeneration: string | null = null;
  const corruptTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  for (;;) {
    if (readShieldsTimerTakeoverToken(sandboxName, options.stateDir) !== takeoverToken) {
      throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
    }
    if (await mcpLifecycleLockPathExists(committedContainmentPath(lockPath))) {
      if (options.throwOnCommittedContainment) {
        const containmentPath = committedContainmentPath(lockPath);
        const reason = `A committed process-tree containment requires operator resolution before auto-restore can continue. Stop all NemoClaw processes for this sandbox; inspect '${lockPath}', '${lockPath}.reaper', '${deadlinePath}', and '${containmentPath}'; record each target's file kind, device/inode, and owner token when present; verify every recorded identity is unchanged; remove only the exact stale owner generations first and the exact containment generation last before retrying.`;
        throw durableMcpLifecycleContainmentFailure(new Error(reason), lockPath);
      }
      if (
        notifiedGeneration !== "committed-containment" &&
        performance.now() - blockedAt >= timeoutMs
      ) {
        await reportDeadlineContainment(options, {
          kind: "failure",
          ownerPid: null,
          reason:
            "A committed process-tree containment requires operator resolution before auto-restore can continue.",
        });
        notifiedGeneration = "committed-containment";
      }
      await sleep(pollIntervalMs);
      continue;
    }

    const token = crypto.randomUUID();
    const owner = createMcpLifecycleLockOwner(sandboxName, token, takeoverToken);
    if (await writeMcpLifecycleLockCandidateAndLink(deadlinePath, owner)) {
      if (readShieldsTimerTakeoverToken(sandboxName, options.stateDir) === takeoverToken) {
        return { lockPath: deadlinePath, token };
      }
      await safelyReleaseMcpLifecycleLock(deadlinePath, token);
      throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
    }

    const observation = await readMcpLifecycleLockObservation(deadlinePath);
    const decision = observation
      ? decideObservedMcpLifecycleLock(
          observation,
          "deadline",
          sandboxName,
          corruptLockGraceMs,
          corruptTracker,
          performance.now(),
        )
      : null;
    if (decision?.kind === "contain") {
      ensureDurableContainmentForStaleGenerationSync(
        lockPath,
        sandboxName,
        options.stateDir ?? resolveNemoclawStateDir(),
        decision.observation,
        "An auto-restore deadline owner exited before its recovery operation completed",
      );
      continue;
    }
    if (observation) {
      const generation = `${String(observation.dev)}:${String(observation.ino)}:${
        observation.owner?.token ?? "invalid"
      }`;
      if (performance.now() - blockedAt >= timeoutMs) {
        const reason =
          "Another auto-restore deadline owner is active or cannot be verified; the deadline gate remains closed pending operator or distributed-lease resolution.";
        if (options.onSetupFailure) {
          blockedAt = performance.now();
          await options.onSetupFailure(new Error(reason));
        }
        if (generation !== notifiedGeneration) {
          await reportDeadlineContainment(options, {
            kind: "failure",
            ownerPid: observation.owner?.pid ?? null,
            reason,
          });
          notifiedGeneration = generation;
        }
        if (options.onSetupFailure) {
          continue;
        }
      }
    } else {
      blockedAt = performance.now();
      notifiedGeneration = null;
      if (options.onSetupFailure) {
        await options.onSetupFailure(
          new Error("Auto-restore could not publish or inspect its lifecycle deadline gate"),
        );
        continue;
      }
    }
    await sleep(pollIntervalMs);
  }
}

function acquireDeadlineFenceSync(
  sandboxName: string,
  takeoverToken: string,
  options: McpLifecycleDeadlineFenceSyncOptions & { stateDir: string },
): AcquiredMcpLifecycleLock {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptLockGraceMs = positiveInteger(
    options.corruptLockGraceMs,
    DEFAULT_CORRUPT_LOCK_GRACE_MS,
  );
  const lockPath = getMcpLifecycleLockPath(sandboxName, options.stateDir);
  const deadlinePath = `${lockPath}.deadline`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  let blockedAt = performance.now();
  let notifiedGeneration: string | null = null;
  const corruptTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  for (;;) {
    if (readShieldsTimerTakeoverToken(sandboxName, options.stateDir) !== takeoverToken) {
      throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
    }
    const containmentPath = committedContainmentPath(lockPath);
    if (mcpLifecycleLockPathExistsSync(containmentPath)) {
      if (options.throwOnCommittedContainment) {
        const reason = `A committed process-tree containment requires operator resolution before auto-restore can continue. Stop all NemoClaw processes for this sandbox; inspect '${lockPath}', '${lockPath}.reaper', '${deadlinePath}', and '${containmentPath}'; record each target's file kind, device/inode, and owner token when present; verify every recorded identity is unchanged; remove only the exact stale owner generations first and the exact containment generation last before retrying.`;
        reportDeadlineContainmentSync(options, {
          kind: "failure",
          ownerPid: null,
          reason,
        });
        throw durableMcpLifecycleContainmentFailure(new Error(reason), lockPath);
      }
      if (
        notifiedGeneration !== "committed-containment" &&
        performance.now() - blockedAt >= timeoutMs
      ) {
        reportDeadlineContainmentSync(options, {
          kind: "failure",
          ownerPid: null,
          reason:
            "A committed process-tree containment requires operator resolution before auto-restore can continue.",
        });
        notifiedGeneration = "committed-containment";
      }
      sleepSync(pollIntervalMs);
      continue;
    }

    const token = crypto.randomUUID();
    const owner = createMcpLifecycleLockOwner(sandboxName, token, takeoverToken);
    if (writeMcpLifecycleLockCandidateAndLinkSync(deadlinePath, owner)) {
      if (readShieldsTimerTakeoverToken(sandboxName, options.stateDir) === takeoverToken) {
        return { lockPath: deadlinePath, token };
      }
      safelyReleaseMcpLifecycleLockSync(deadlinePath, token);
      throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
    }

    const observation = readMcpLifecycleLockObservationSync(deadlinePath);
    const decision = observation
      ? decideObservedMcpLifecycleLock(
          observation,
          "deadline",
          sandboxName,
          corruptLockGraceMs,
          corruptTracker,
          performance.now(),
        )
      : null;
    if (decision?.kind === "contain") {
      ensureDurableContainmentForStaleGenerationSync(
        lockPath,
        sandboxName,
        options.stateDir,
        decision.observation,
        "An auto-restore deadline owner exited before its recovery operation completed",
      );
      continue;
    }
    if (observation) {
      const generation = `${String(observation.dev)}:${String(observation.ino)}:${
        observation.owner?.token ?? "invalid"
      }`;
      if (generation !== notifiedGeneration && performance.now() - blockedAt >= timeoutMs) {
        reportDeadlineContainmentSync(options, {
          kind: "failure",
          ownerPid: observation.owner?.pid ?? null,
          reason:
            "Another auto-restore deadline owner is active or cannot be verified; the deadline gate remains closed pending operator or distributed-lease resolution.",
        });
        notifiedGeneration = generation;
      }
    } else {
      blockedAt = performance.now();
      notifiedGeneration = null;
    }
    sleepSync(pollIntervalMs);
  }
}

async function clearDeadlineProtectedPath(
  targetPath: string,
  targetLabel: string,
  sandboxName: string,
  takeoverToken: string,
  stateDir: string,
  options: McpLifecycleDeadlineFenceOptions,
): Promise<void> {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const containmentTimeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  let blockedAt = performance.now();
  let notifiedGeneration: string | null = null;

  for (;;) {
    if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
      throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
    }
    const observed = await readMcpLifecycleLockObservation(targetPath);
    if (!observed) return;

    const decision = decideObservedMcpLifecycleLock(
      observed,
      targetPath.endsWith(".reaper") ? "reaper" : "main",
      sandboxName,
      0,
      corruptTracker,
      performance.now(),
    );
    const owner = observed.owner;
    const exactLocalOwner =
      owner?.sandboxName === sandboxName &&
      Boolean(owner.processIdentity) &&
      owner.hostIdentity === readMcpLockHostIdentity() &&
      owner.pidNamespaceIdentity === readMcpLockPidNamespaceIdentity();
    const exactCurrentOrdinaryOwner =
      !targetPath.endsWith(".reaper") &&
      decision.kind === "wait" &&
      decision.disposition === "active" &&
      exactLocalOwner &&
      readMcpLockProcessIdentity(owner.pid, true) === owner.processIdentity;
    if ((decision.kind === "reap" || decision.kind === "contain") && exactLocalOwner) {
      const confirmed = await readMcpLifecycleLockObservation(targetPath);
      if (!sameLockGeneration(observed, confirmed)) continue;
      if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
        throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
      }
      const lifecyclePath = targetPath.endsWith(".reaper")
        ? targetPath.slice(0, -".reaper".length)
        : targetPath;
      ensureDurableContainmentForStaleGenerationSync(
        lifecyclePath,
        sandboxName,
        stateDir,
        observed,
        `The ${targetLabel} owner PID ${String(owner?.pid)} was already gone before takeover`,
      );
      throw durableMcpLifecycleContainmentFailure(
        new Error(
          `The exact ${targetLabel} owner was already gone, so surviving descendants cannot be ruled out`,
        ),
        lifecyclePath,
      );
    }

    const generation = `${String(observed.dev)}:${String(observed.ino)}:${
      owner?.token ?? "invalid"
    }`;
    if (performance.now() - blockedAt >= containmentTimeoutMs) {
      if (exactCurrentOrdinaryOwner) {
        const reason = `The verified live ${targetLabel} owner PID ${String(owner.pid)} is still completing its lifecycle transaction. Shields remain DOWN and the deadline gate is blocking new mutations until that owner releases the lock.`;
        if (generation !== notifiedGeneration) {
          await reportDeadlineContainment(options, {
            kind: "verified-live-wait",
            ownerPid: owner.pid,
            reason,
          });
          notifiedGeneration = generation;
        }
        await sleep(pollIntervalMs);
        continue;
      }
      const reason = `The active or unverifiable ${targetLabel} owner was preserved because portable process inspection cannot prove that forcibly terminating it would contain every descendant. Shields remain DOWN and the deadline gate is blocking new mutations. Wait for the owner to finish, or stop all NemoClaw processes for this sandbox before resolving the recorded lock generation.`;
      if (options.onSetupFailure) {
        blockedAt = performance.now();
        await options.onSetupFailure(new Error(reason));
      }
      if (generation !== notifiedGeneration) {
        await reportDeadlineContainment(options, {
          kind: "failure",
          ownerPid: owner?.pid ?? null,
          reason,
        });
        notifiedGeneration = generation;
      }
      if (options.onSetupFailure) {
        continue;
      }
    }
    await sleep(pollIntervalMs);
  }
}

function clearDeadlineProtectedPathSync(
  targetPath: string,
  targetLabel: string,
  sandboxName: string,
  takeoverToken: string,
  stateDir: string,
  options: McpLifecycleDeadlineFenceSyncOptions,
): void {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const containmentTimeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const corruptTracker: CorruptGenerationTracker = { generation: null, firstSeenAt: 0 };
  let blockedAt = performance.now();
  let notifiedGeneration: string | null = null;

  for (;;) {
    if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
      throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
    }
    const observed = readMcpLifecycleLockObservationSync(targetPath);
    if (!observed) return;

    const decision = decideObservedMcpLifecycleLock(
      observed,
      targetPath.endsWith(".reaper") ? "reaper" : "main",
      sandboxName,
      0,
      corruptTracker,
      performance.now(),
    );
    const owner = observed.owner;
    const exactLocalOwner =
      owner?.sandboxName === sandboxName &&
      Boolean(owner.processIdentity) &&
      owner.hostIdentity === readMcpLockHostIdentity() &&
      owner.pidNamespaceIdentity === readMcpLockPidNamespaceIdentity();
    const currentProcessIdentity =
      exactLocalOwner && owner?.pid === process.pid
        ? readMcpLockProcessIdentity(process.pid, true)
        : null;
    if (
      exactLocalOwner &&
      owner?.pid === process.pid &&
      currentProcessIdentity !== null &&
      owner.processIdentity === currentProcessIdentity
    ) {
      const error = new Error(
        "Synchronous auto-restore cannot wait behind a sibling lifecycle operation in this process",
      ) as Error & { code: string };
      error.code = "NEMOCLAW_SYNC_REENTRANT_OWNER";
      throw error;
    }
    if ((decision.kind === "reap" || decision.kind === "contain") && exactLocalOwner) {
      const confirmed = readMcpLifecycleLockObservationSync(targetPath);
      if (!sameLockGeneration(observed, confirmed)) continue;
      if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
        throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
      }
      const lifecyclePath = targetPath.endsWith(".reaper")
        ? targetPath.slice(0, -".reaper".length)
        : targetPath;
      ensureDurableContainmentForStaleGenerationSync(
        lifecyclePath,
        sandboxName,
        stateDir,
        observed,
        `The ${targetLabel} owner PID ${String(owner?.pid)} was already gone before takeover`,
      );
      throw durableMcpLifecycleContainmentFailure(
        new Error(
          `The exact ${targetLabel} owner was already gone, so surviving descendants cannot be ruled out`,
        ),
        lifecyclePath,
      );
    }
    if (exactLocalOwner && owner?.pid === process.pid && currentProcessIdentity === null) {
      const error = new Error(
        "Synchronous auto-restore cannot verify the process identity of a same-PID lifecycle owner",
      ) as Error & { code: string };
      error.code = "NEMOCLAW_SYNC_REENTRANT_OWNER";
      throw error;
    }

    const generation = `${String(observed.dev)}:${String(observed.ino)}:${
      owner?.token ?? "invalid"
    }`;
    if (
      generation !== notifiedGeneration &&
      performance.now() - blockedAt >= containmentTimeoutMs
    ) {
      reportDeadlineContainmentSync(options, {
        kind: "failure",
        ownerPid: owner?.pid ?? null,
        reason: `The active ${targetLabel} owner was preserved because portable process inspection cannot prove that forcibly terminating it would contain every descendant. Shields remain DOWN and the deadline gate is blocking new mutations. Wait for the owner to finish, or stop all NemoClaw processes for this sandbox before resolving the recorded lock generation.`,
      });
      notifiedGeneration = generation;
    }
    sleepSync(pollIntervalMs);
  }
}

async function publishDeadlineMainOwner(
  lockPath: string,
  sandboxName: string,
  takeoverToken: string,
  stateDir: string,
  options: McpLifecycleDeadlineFenceOptions,
): Promise<string> {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  let notifiedError: string | null = null;
  let pendingCandidateToken: string | null = null;
  for (;;) {
    try {
      if (pendingCandidateToken) {
        const existingSelfToken = selfOwnedDeadlineMainToken(
          await readMcpLifecycleLockObservation(lockPath),
          sandboxName,
          takeoverToken,
          pendingCandidateToken,
        );
        if (existingSelfToken) return existingSelfToken;
        pendingCandidateToken = null;
      }
      await clearDeadlineProtectedPath(
        `${lockPath}.reaper`,
        "stale-lock reaper",
        sandboxName,
        takeoverToken,
        stateDir,
        options,
      );
      await clearDeadlineProtectedPath(
        lockPath,
        "sandbox mutation",
        sandboxName,
        takeoverToken,
        stateDir,
        options,
      );
      if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
        throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
      }
      const candidateToken = crypto.randomUUID();
      pendingCandidateToken = candidateToken;
      const timerOwner = createMcpLifecycleLockOwner(sandboxName, candidateToken, takeoverToken);
      if (await writeMcpLifecycleLockCandidateAndLink(lockPath, timerOwner)) {
        return candidateToken;
      }
      pendingCandidateToken = null;
      notifiedError = null;
      if (options.onSetupFailure) {
        await options.onSetupFailure(
          new Error("Auto-restore could not publish its deadline-owned mutation generation"),
        );
        continue;
      }
    } catch (error) {
      if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
        throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isDurableContainmentError(error)) {
        const resolutionReason = `${message} The deadline gate remains closed. Stop all NemoClaw processes for this sandbox; inspect '${lockPath}', '${lockPath}.reaper', '${lockPath}.deadline', and '${committedContainmentPath(lockPath)}'; record each target's file kind, device/inode, and owner token when present; verify every recorded identity is unchanged; remove only the exact stale owner generations first and the exact containment generation last before retrying.`;
        if (options.throwOnCommittedContainment) {
          const failure = durableMcpLifecycleContainmentFailure(error, lockPath);
          failure.message = resolutionReason;
          throw failure;
        }
        if (message !== notifiedError) {
          await reportDeadlineContainment(options, {
            kind: "failure",
            ownerPid: null,
            reason: resolutionReason,
          });
          notifiedError = message;
        }
        while (
          readShieldsTimerTakeoverToken(sandboxName, stateDir) === takeoverToken &&
          ((await mcpLifecycleLockPathExists(committedContainmentPath(lockPath))) ||
            (await deadlineMainStillPresent(lockPath)))
        ) {
          await sleep(pollIntervalMs);
        }
        if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
          throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
        }
        continue;
      }
      if (options.onSetupFailure) await options.onSetupFailure(error);
      if (message !== notifiedError) {
        await reportDeadlineContainment(options, {
          kind: "failure",
          ownerPid: null,
          reason: `Auto-restore deadline setup is retrying while the gate remains closed: ${message}`,
        });
        notifiedError = message;
      }
      if (options.onSetupFailure) {
        continue;
      }
    }
    await sleep(pollIntervalMs);
  }
}

function publishDeadlineMainOwnerSync(
  lockPath: string,
  sandboxName: string,
  takeoverToken: string,
  stateDir: string,
  options: McpLifecycleDeadlineFenceSyncOptions,
): string {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  let notifiedError: string | null = null;
  let pendingCandidateToken: string | null = null;
  for (;;) {
    try {
      if (pendingCandidateToken) {
        const existingSelfToken = selfOwnedDeadlineMainToken(
          readMcpLifecycleLockObservationSync(lockPath),
          sandboxName,
          takeoverToken,
          pendingCandidateToken,
        );
        if (existingSelfToken) return existingSelfToken;
        pendingCandidateToken = null;
      }
      clearDeadlineProtectedPathSync(
        `${lockPath}.reaper`,
        "stale-lock reaper",
        sandboxName,
        takeoverToken,
        stateDir,
        options,
      );
      clearDeadlineProtectedPathSync(
        lockPath,
        "sandbox mutation",
        sandboxName,
        takeoverToken,
        stateDir,
        options,
      );
      if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
        throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
      }
      const candidateToken = crypto.randomUUID();
      pendingCandidateToken = candidateToken;
      const timerOwner = createMcpLifecycleLockOwner(sandboxName, candidateToken, takeoverToken);
      if (writeMcpLifecycleLockCandidateAndLinkSync(lockPath, timerOwner)) {
        return candidateToken;
      }
      pendingCandidateToken = null;
      notifiedError = null;
    } catch (error) {
      if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
        throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
      }
      if (
        error instanceof Error &&
        (error as Error & { code?: string }).code === "NEMOCLAW_SYNC_REENTRANT_OWNER"
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isDurableContainmentError(error)) {
        const resolutionReason = `${message} The deadline gate remains closed. Stop all NemoClaw processes for this sandbox; inspect '${lockPath}', '${lockPath}.reaper', '${lockPath}.deadline', and '${committedContainmentPath(lockPath)}'; record each target's file kind, device/inode, and owner token when present; verify every recorded identity is unchanged; remove only the exact stale owner generations first and the exact containment generation last before retrying.`;
        if (message !== notifiedError) {
          reportDeadlineContainmentSync(options, {
            kind: "failure",
            ownerPid: null,
            reason: resolutionReason,
          });
          notifiedError = message;
        }
        if (options.throwOnCommittedContainment) {
          const failure = durableMcpLifecycleContainmentFailure(error, lockPath);
          failure.message = resolutionReason;
          throw failure;
        }
        while (
          readShieldsTimerTakeoverToken(sandboxName, stateDir) === takeoverToken &&
          (mcpLifecycleLockPathExistsSync(committedContainmentPath(lockPath)) ||
            deadlineMainStillPresentSync(lockPath))
        ) {
          sleepSync(pollIntervalMs);
        }
        if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
          throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
        }
        continue;
      }
      if (message !== notifiedError) {
        reportDeadlineContainmentSync(options, {
          kind: "failure",
          ownerPid: null,
          reason: `Auto-restore deadline setup is retrying while the gate remains closed: ${message}`,
        });
        notifiedError = message;
      }
    }
    sleepSync(pollIntervalMs);
  }
}

/**
 * Establish the auto-restore deadline as a generation-pinned exclusion fence.
 *
 * Ordinary acquisitions refuse to enter while `<lock>.deadline` exists.
 * The timer keeps that gate through policy restoration and configuration re-locking,
 * and waits for an active owner to release naturally. Portable PID inspection
 * cannot prove that force-killing a process also contained every descendant.
 */
export async function withMcpLifecycleDeadlineFence<T>(
  sandboxName: string,
  takeoverToken: string,
  operation: () => Promise<T> | T,
  options: McpLifecycleDeadlineFenceOptions,
): Promise<T> {
  if (!/^[0-9a-f]{32}$/.test(takeoverToken)) {
    throw new Error("Auto-restore takeover token must be 32 lowercase hexadecimal characters");
  }
  const stateDir = options.stateDir ?? resolveNemoclawStateDir();
  const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
  const inherited = heldLocks.getStore();
  if (inherited?.get(lockPath)?.active) return await operation();

  const fence = await acquireDeadlineFence(sandboxName, takeoverToken, {
    ...options,
    stateDir,
  });
  let mainToken: string | null = null;
  let retainOwnedGate = false;
  let lease: HeldLockLease | null = null;
  try {
    // An ordinary acquirer can pass its pre-publication deadline check before
    // this fence exists, then link the main path after an earlier clear. Keep
    // the fence and repeat takeover until this timer owns the main generation.
    mainToken = await publishDeadlineMainOwner(
      lockPath,
      sandboxName,
      takeoverToken,
      stateDir,
      options,
    );

    const activeLease: HeldLockLease = {
      active: true,
      retainForDurableContainment: false,
    };
    lease = activeLease;
    const context = new Map(inherited ?? []);
    context.set(lockPath, activeLease);
    return await heldLocks.run(context, async () => {
      try {
        if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
          throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
        }
        return await operation();
      } finally {
        activeLease.active = false;
      }
    });
  } catch (error) {
    retainOwnedGate = await retainOwnedLifecycleGateAfterFailure(error, lockPath);
    throw error;
  } finally {
    if (!retainOwnedGate && lease?.retainForDurableContainment) {
      retainOwnedGate = await ownedLifecycleGateMustRemainClosed(lockPath);
    }
    if (!retainOwnedGate) {
      if (mainToken) await safelyReleaseMcpLifecycleLock(lockPath, mainToken);
      await safelyReleaseMcpLifecycleLock(fence.lockPath, fence.token);
      options.onReleased?.();
    }
  }
}

/**
 * Synchronous deadline fence for inline recovery from synchronous status and
 * permission-inspection paths.
 */
export function withMcpLifecycleDeadlineFenceSync<T>(
  sandboxName: string,
  takeoverToken: string,
  operation: () => T,
  options: McpLifecycleDeadlineFenceSyncOptions,
): T {
  if (!/^[0-9a-f]{32}$/.test(takeoverToken)) {
    throw new Error("Auto-restore takeover token must be 32 lowercase hexadecimal characters");
  }
  const stateDir = options.stateDir ?? resolveNemoclawStateDir();
  const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
  const inherited = heldLocks.getStore();
  if (inherited?.get(lockPath)?.active) return operation();
  const fence = acquireDeadlineFenceSync(sandboxName, takeoverToken, {
    ...options,
    stateDir,
  });
  let mainToken: string | null = null;
  let retainOwnedGate = false;
  let lease: HeldLockLease | null = null;
  try {
    mainToken = publishDeadlineMainOwnerSync(
      lockPath,
      sandboxName,
      takeoverToken,
      stateDir,
      options,
    );

    const activeLease: HeldLockLease = {
      active: true,
      retainForDurableContainment: false,
    };
    lease = activeLease;
    const context = new Map(inherited ?? []);
    context.set(lockPath, activeLease);
    try {
      if (readShieldsTimerTakeoverToken(sandboxName, stateDir) !== takeoverToken) {
        throw new Error(`Auto-restore authority changed for sandbox '${sandboxName}'`);
      }
      return heldLocks.run(context, operation);
    } finally {
      activeLease.active = false;
    }
  } catch (error) {
    retainOwnedGate = retainOwnedLifecycleGateAfterFailureSync(error, lockPath);
    throw error;
  } finally {
    if (!retainOwnedGate && lease?.retainForDurableContainment) {
      retainOwnedGate = ownedLifecycleGateMustRemainClosedSync(lockPath);
    }
    if (!retainOwnedGate) {
      if (mainToken) safelyReleaseMcpLifecycleLockSync(lockPath, mainToken);
      safelyReleaseMcpLifecycleLockSync(fence.lockPath, fence.token);
    }
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
  const lease: HeldLockLease = {
    active: true,
    retainForDurableContainment: false,
  };
  const context = new Map(inherited ?? []);
  context.set(lockPath, lease);
  let retainOwnedGate = false;
  try {
    return heldLocks.run(context, () => {
      acquired.assertBeforeDeadline();
      return operation();
    });
  } catch (error) {
    retainOwnedGate =
      Boolean(acquired.shieldsTakeoverToken) &&
      retainOwnedLifecycleGateAfterFailureSync(error, lockPath);
    throw error;
  } finally {
    lease.active = false;
    if (!retainOwnedGate && acquired.shieldsTakeoverToken && lease.retainForDurableContainment) {
      retainOwnedGate = ownedLifecycleGateMustRemainClosedSync(lockPath);
    }
    if (!retainOwnedGate) {
      safelyReleaseMcpLifecycleLockSync(acquired.lockPath, acquired.token);
    }
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
  const lease: HeldLockLease = {
    active: true,
    retainForDurableContainment: false,
  };
  const context = new Map(inherited ?? []);
  context.set(lockKey, lease);
  return heldLocks.run(context, async () => {
    let retainOwnedGate = false;
    try {
      acquired.assertBeforeDeadline();
      return await operation();
    } catch (error) {
      retainOwnedGate =
        Boolean(acquired.shieldsTakeoverToken) &&
        (await retainOwnedLifecycleGateAfterFailure(error, lockKey));
      throw error;
    } finally {
      // Async resources created by the callback retain their ALS store. Mark
      // the lease inactive before releasing so a detached/later promise cannot
      // mistake an ended parent operation for a still-held reentrant lock.
      lease.active = false;
      if (!retainOwnedGate && acquired.shieldsTakeoverToken && lease.retainForDurableContainment) {
        retainOwnedGate = await ownedLifecycleGateMustRemainClosed(lockKey);
      }
      if (!retainOwnedGate) {
        await safelyReleaseMcpLifecycleLock(acquired.lockPath, acquired.token);
      }
    }
  });
}
