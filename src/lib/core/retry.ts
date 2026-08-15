// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface RetryUntilBaseOptions<T> {
  /** Return true when the current result completes the retry operation. */
  accept: (result: T, attempt: number) => boolean;
  /** Delays before each additional attempt. */
  retryDelaysMs: readonly number[];
}

export type RetryUntilOptions<T> = RetryUntilBaseOptions<T> & {
  /** Sleep function used between attempts. */
  sleep: (ms: number) => void;
};

export type RetryUntilAsyncOptions<T> = RetryUntilBaseOptions<T> & {
  /** Sleep function used between attempts. */
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
    await options.sleep(delayMs);
    attempt += 1;
    result = await operation(attempt);
    if (options.accept(result, attempt)) return result;
  }
  return result;
}
