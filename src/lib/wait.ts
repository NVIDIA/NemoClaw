// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous waiting primitives for CLI commands.
 */

/**
 * Synchronously sleep for the given number of milliseconds.
 * Uses Atomics.wait to block without pegging the CPU.
 */
export function sleepMs(ms: number): void {
  if (ms <= 0 || !Number.isFinite(ms)) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Synchronously sleep for the given number of seconds.
 */
export function sleepSeconds(seconds: number): void {
  sleepMs(seconds * 1000);
}
