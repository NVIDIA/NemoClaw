// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

import { isMcpLifecycleLockHeld } from "../../state/mcp-lifecycle-lock-acquisition";

const MAX_REUSE_MS = 60_000;

export interface HermesPortableStartupOperation {
  readonly sandboxName: string;
  readonly stateDir: string | undefined;
  readonly current: () => boolean;
}

const operations = new AsyncLocalStorage<HermesPortableStartupOperation>();

/** Enable the bounded startup reuse gate by default; reject unknown values. */
export function hermesPortableStartupReuseGateEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE === undefined ||
    env.NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE === "1"
  );
}

async function withSelectedHermesPortableStartupOperation<T>(
  sandboxName: string,
  stateDir: string | undefined,
  operation: () => Promise<T> | T,
  profileSelected: () => boolean,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<T> {
  if (!profileSelected() || !hermesPortableStartupReuseGateEnabled(env)) {
    return await operation();
  }
  const retained = currentHermesPortableStartupOperation(sandboxName);
  if (retained && retained.stateDir === stateDir) return await operation();
  const started = now();
  let previous = started;
  let active = Number.isFinite(started);
  const scope: HermesPortableStartupOperation = Object.freeze({
    sandboxName,
    stateDir,
    current: () => {
      const current = now();
      active &&=
        profileSelected() &&
        hermesPortableStartupReuseGateEnabled(env) &&
        Number.isFinite(current) &&
        current >= previous &&
        current - started < MAX_REUSE_MS &&
        isMcpLifecycleLockHeld(sandboxName, stateDir);
      previous = current;
      return active;
    },
  });
  return await operations.run(scope, async () => {
    try {
      return await operation();
    } finally {
      active = false;
    }
  });
}

/** Reuse evidence only beneath an explicitly selected profile, live fence, and bounded invocation. */
export async function withHermesPortableStartupOperation<T>(
  sandboxName: string,
  stateDir: string | undefined,
  operation: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => performance.now(),
): Promise<T> {
  return await withSelectedHermesPortableStartupOperation(
    sandboxName,
    stateDir,
    operation,
    () => env.NEMOCLAW_EXPERIMENTAL_PROFILE === "portable",
    env,
    now,
  );
}

/** Retain an already-recorded Portable opt-in when a later command has no profile environment. */
export async function withPersistedHermesPortableStartupOperation<T>(
  sandboxName: string,
  stateDir: string | undefined,
  operation: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => performance.now(),
): Promise<T> {
  return await withSelectedHermesPortableStartupOperation(
    sandboxName,
    stateDir,
    operation,
    () => {
      const profile = env.NEMOCLAW_EXPERIMENTAL_PROFILE;
      return profile === undefined || profile === "portable";
    },
    env,
    now,
  );
}

export function currentHermesPortableStartupOperation(
  sandboxName: string,
): HermesPortableStartupOperation | undefined {
  const scope = operations.getStore();
  return scope?.sandboxName === sandboxName && scope.current() ? scope : undefined;
}
