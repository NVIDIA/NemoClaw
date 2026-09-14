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

/** Reuse evidence only beneath the same live lifecycle fence and bounded invocation. */
export async function withHermesPortableStartupOperation<T>(
  sandboxName: string,
  stateDir: string | undefined,
  operation: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => performance.now(),
): Promise<T> {
  if (
    env.NEMOCLAW_EXPERIMENTAL_PROFILE !== "portable" ||
    env.NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE !== "1"
  ) {
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

export function currentHermesPortableStartupOperation(
  sandboxName: string,
): HermesPortableStartupOperation | undefined {
  const scope = operations.getStore();
  return scope?.sandboxName === sandboxName && scope.current() ? scope : undefined;
}
