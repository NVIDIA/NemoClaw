// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WaitUntilOptions } from "../core/wait";

export { sleepMs, waitUntil, waitUntilAsync } from "../core/wait";

const DEFAULT_INITIAL_INTERVAL_MS = 250;
const DEFAULT_MAX_INTERVAL_MS = 2_000;
const DEFAULT_BACKOFF_FACTOR = 1.5;

function nonNegativeFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

export function getLegacyPollDeadlineBudgetMs(
  pollCount: number,
  pollIntervalSeconds: number,
): number {
  const count = nonNegativeFinite(pollCount);
  const intervalSeconds = nonNegativeFinite(pollIntervalSeconds);
  const budgetMs = count * intervalSeconds * 1000;
  return Number.isFinite(budgetMs)
    ? Math.min(Number.MAX_SAFE_INTEGER, budgetMs)
    : Number.MAX_SAFE_INTEGER;
}

export function createReadinessWaitOptions(options: {
  budgetMs: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  zeroBudgetAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => void | Promise<void>;
}): WaitUntilOptions | null {
  const budgetMs = nonNegativeFinite(options.budgetMs);
  const maxIntervalMs = nonNegativeFinite(
    options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS,
    DEFAULT_MAX_INTERVAL_MS,
  );
  const initialIntervalMs = Math.min(
    nonNegativeFinite(options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS),
    maxIntervalMs,
  );
  const zeroBudgetAttempts = Math.floor(nonNegativeFinite(options.zeroBudgetAttempts ?? 0));
  const sourceNow = options.now ?? Date.now;
  const startedAt = sourceNow();
  let logicalNow = startedAt;
  const now = () => Math.max(sourceNow(), logicalNow);
  const sleep = options.sleep
    ? (ms: number): void | Promise<void> => {
        const beforeSleep = now();
        const result = options.sleep?.(ms);
        const advanceLogicalClock = () => {
          logicalNow = Math.max(sourceNow(), beforeSleep + ms);
        };
        if (result && typeof (result as Promise<void>).then === "function") {
          return Promise.resolve(result).then(advanceLogicalClock);
        }
        advanceLogicalClock();
      }
    : undefined;
  const common = {
    initialIntervalMs,
    maxIntervalMs,
    backoffFactor: DEFAULT_BACKOFF_FACTOR,
    now,
    ...(sleep ? { sleep } : {}),
  } satisfies WaitUntilOptions;

  if (budgetMs === 0) {
    return zeroBudgetAttempts > 0
      ? { ...common, initialIntervalMs: 0, maxIntervalMs: 0, maxAttempts: zeroBudgetAttempts }
      : null;
  }

  return {
    ...common,
    deadlineMs: startedAt + budgetMs,
  };
}

export function formatReadinessDeadline(budgetMs: number): string {
  const normalizedBudgetMs = nonNegativeFinite(budgetMs);
  if (normalizedBudgetMs < 1000) return `${Math.ceil(normalizedBudgetMs)}ms`;
  const seconds = normalizedBudgetMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}
