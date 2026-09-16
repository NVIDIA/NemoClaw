// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { runOnboardProcessAsync } from "./onboard-child-process-harness";

type HarnessProcess = typeof runOnboardProcessAsync;

type Waiter = {
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
};

export function createAbortAwareLimiter(
  concurrency: number,
): <Result>(signal: AbortSignal, run: () => Promise<Result>) => Promise<Result> {
  let active = 0;
  const waiters: Waiter[] = [];

  const grantNext = () => {
    while (active < concurrency) {
      const waiter = waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      active += 1;
      waiter.resolve();
    }
  };

  const acquire = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          signal.removeEventListener("abort", waiter.onAbort);
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(signal.reason);
          grantNext();
        },
      };
      waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
  };

  return async <Result>(signal: AbortSignal, run: () => Promise<Result>): Promise<Result> => {
    await acquire(signal);
    try {
      return await run();
    } finally {
      active -= 1;
      grantNext();
    }
  };
}

export function createControlledHarnessProcess(): {
  activeHomes: Set<string>;
  release: (home: string) => void;
  releaseAll: () => void;
  run: HarnessProcess;
} {
  const activeHomes = new Set<string>();
  const releases = new Map<string, () => void>();
  const release = (home: string) => {
    releases.get(home)?.();
    releases.delete(home);
  };
  const releaseAll = () => {
    for (const pendingRelease of releases.values()) pendingRelease();
    releases.clear();
  };
  const run: HarnessProcess = async (_arguments, options) => {
    const home = options.env.HOME;
    if (!home) throw new Error("harness HOME is required");
    activeHomes.add(home);
    await new Promise<void>((resolve) => releases.set(home, resolve));
    activeHomes.delete(home);
    return { status: 0, signal: null, error: undefined, stdout: "", stderr: "", output: "" };
  };
  return { activeHomes, release, releaseAll, run };
}
