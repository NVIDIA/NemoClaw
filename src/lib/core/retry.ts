// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface RetryUntilBaseOptions<T> {
  /** Return true to stop retrying after this result. */
  accept: (result: T, attempt: number) => boolean;
  /** Delay in milliseconds before each additional attempt. */
  retryDelaysMs: readonly number[];
}

export type RetryUntilOptions<T> = RetryUntilBaseOptions<T> & {
  /** Run after `accept` returns false and before the scheduled sleep. */
  onRetry?: (result: T, delayMs: number, attempt: number) => void;
  /** Sleep for the specified number of milliseconds between attempts. */
  sleep: (ms: number) => void;
};

export type RetryUntilAsyncOptions<T> = RetryUntilBaseOptions<T> & {
  /** Run after `accept` returns false and before the scheduled sleep. */
  onRetry?: (result: T, delayMs: number, attempt: number) => void | Promise<void>;
  /** Sleep for the specified number of milliseconds between attempts. */
  sleep: (ms: number) => Promise<void>;
};

/**
 * Retry a synchronous operation until its result is accepted or the delay
 * schedule is exhausted. Returns the final operation result.
 */
export function retryUntil<T>(operation: (attempt: number) => T, options: RetryUntilOptions<T>): T {
  let attempt = 1;
  let result = operation(attempt);
  if (options.accept(result, attempt)) return result;

  for (const delayMs of options.retryDelaysMs) {
    options.onRetry?.(result, delayMs, attempt);

    options.sleep(delayMs);
    attempt += 1;
    result = operation(attempt);
    if (options.accept(result, attempt)) return result;
  }
  return result;
}

/**
 * Retry an asynchronous operation until its result is accepted or the delay
 * schedule is exhausted. Returns the final operation result.
 */
export async function retryUntilAsync<T>(
  operation: (attempt: number) => T | Promise<T>,
  options: RetryUntilAsyncOptions<T>,
): Promise<T> {
  let attempt = 1;
  let result = await operation(attempt);
  if (options.accept(result, attempt)) return result;

  for (const delayMs of options.retryDelaysMs) {
    await options.onRetry?.(result, delayMs, attempt);

    await options.sleep(delayMs);
    attempt += 1;
    result = await operation(attempt);
    if (options.accept(result, attempt)) return result;
  }
  return result;
}
