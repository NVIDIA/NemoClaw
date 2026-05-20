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

/**
 * Synchronously wait until a condition is met.
 */
export function waitUntil(
  conditionFn: () => boolean,
  timeoutSeconds = 10,
  pollIntervalMs = 250,
): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    if (conditionFn()) return true;
    sleepMs(pollIntervalMs);
  }
  return false;
}

/**
 * Synchronously wait for a TCP port to become reachable on localhost.
 */
export function waitForPort(port: number, timeoutSeconds = 5): boolean {
  const { spawnSync } = require("node:child_process");
  return waitUntil(() => {
    try {
      const result = spawnSync("nc", ["-z", "127.0.0.1", String(port)], { stdio: "ignore" });
      return result.status === 0;
    } catch {
      return false;
    }
  }, timeoutSeconds, 200);
}

/**
 * Synchronously wait for an HTTP endpoint to return a success status code.
 */
export function waitForHttp(url: string, timeoutSeconds = 5): boolean {
  const { spawnSync } = require("node:child_process");
  return waitUntil(() => {
    try {
      const result = spawnSync(
        "curl",
        ["-sf", "--connect-timeout", "1", "--max-time", "1", url],
        { stdio: "ignore" },
      );
      return result.status === 0;
    } catch {
      return false;
    }
  }, timeoutSeconds, 200);
}
