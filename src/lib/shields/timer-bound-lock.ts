// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readAutoRestoreTakeoverToken } from "./timer-control";
import {
  type ShieldsTransitionLockOptions,
  withShieldsTransitionLock,
  withShieldsTransitionLockAsync,
} from "./transition-lock";

export {
  beginCommittedMcpLifecycleContainmentSync,
  durableMcpLifecycleContainmentFailure,
  getMcpLifecycleLockPath,
  isMcpLifecycleLockHeld,
  readMcpLockProcessIdentity,
  withMcpLifecycleDeadlineFenceSync,
  withMcpLifecycleLockSync,
} from "../state/mcp-lifecycle-lock";

const MAX_TIMER_GENERATION_RETRIES = 3;

type TimerBoundLockDeps = {
  readToken: (sandboxName: string) => string | undefined;
  withLock: typeof withShieldsTransitionLock;
  withLockAsync: typeof withShieldsTransitionLockAsync;
};

const defaultDeps: TimerBoundLockDeps = {
  readToken: readAutoRestoreTakeoverToken,
  withLock: withShieldsTransitionLock,
  withLockAsync: withShieldsTransitionLockAsync,
};

type Attempt<T> = { retry: true } | { retry: false; value: T };

function withTimerBoundShieldsMutationLockOptions<T>(
  sandboxName: string,
  command: string,
  fn: () => T,
  lockOptions: ShieldsTransitionLockOptions,
  deps: TimerBoundLockDeps,
  fallbackTakeoverToken?: string,
): T {
  for (let attempt = 0; attempt < MAX_TIMER_GENERATION_RETRIES; attempt += 1) {
    const token = deps.readToken(sandboxName);
    const takeoverToken = token ?? fallbackTakeoverToken;
    const result = deps.withLock<Attempt<T>>(
      sandboxName,
      command,
      () => {
        if (deps.readToken(sandboxName) !== token) return { retry: true };
        return { retry: false, value: fn() };
      },
      {
        ...lockOptions,
        ...(takeoverToken ? { takeoverToken } : {}),
      },
    );
    if (!result.retry) return result.value;
  }
  throw new Error(`Auto-restore timer generation kept changing while acquiring '${command}'`);
}

/**
 * Bind a fresh timer generation before its marker exists, while still giving
 * an already-published marker generation priority during recovery.
 */
export function withTimerBoundShieldsMutationLockFallback<T>(
  sandboxName: string,
  command: string,
  fallbackTakeoverToken: string,
  fn: () => T,
  deps: TimerBoundLockDeps = defaultDeps,
): T {
  return withTimerBoundShieldsMutationLockOptions(
    sandboxName,
    command,
    fn,
    {},
    deps,
    fallbackTakeoverToken,
  );
}

/**
 * Serialize a mutation and bind its lock owner to the exact active restore
 * timer generation. If a timer is replaced while this operation waits for the
 * lock, release without mutating and retry with the new token. This prevents a
 * command that observed timer A from becoming non-preemptible inside timer B's
 * mutable window.
 */
export function withTimerBoundShieldsMutationLock<T>(
  sandboxName: string,
  command: string,
  fn: () => T,
  deps: TimerBoundLockDeps = defaultDeps,
): T {
  return withTimerBoundShieldsMutationLockOptions(sandboxName, command, fn, {}, deps);
}

/**
 * Auto-restore uses a stronger stale-owner protocol than ordinary commands.
 * A stale transition owner is preserved so the recovery coordinator can
 * publish durable containment instead of deleting a generation whose
 * descendants cannot be ruled out.
 */
export function withTimerBoundAutoRestoreLock<T>(
  sandboxName: string,
  command: string,
  fn: () => T,
): T {
  return withTimerBoundShieldsMutationLockOptions(
    sandboxName,
    command,
    fn,
    { recoverStaleOwner: false, waitTimeoutMs: 0 },
    defaultDeps,
  );
}

export async function withTimerBoundShieldsMutationLockAsync<T>(
  sandboxName: string,
  command: string,
  fn: () => Promise<T>,
  deps: TimerBoundLockDeps = defaultDeps,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_TIMER_GENERATION_RETRIES; attempt += 1) {
    const token = deps.readToken(sandboxName);
    const result = await deps.withLockAsync<Attempt<T>>(
      sandboxName,
      command,
      async () => {
        if (deps.readToken(sandboxName) !== token) return { retry: true };
        return { retry: false, value: await fn() };
      },
      token ? { takeoverToken: token } : {},
    );
    if (!result.retry) return result.value;
  }
  throw new Error(`Auto-restore timer generation kept changing while acquiring '${command}'`);
}
