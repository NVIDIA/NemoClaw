// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous waiting primitives for CLI commands.
 */

import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import { withLocalNoProxy } from "../subprocess-env.js";

export type WaitUntilOptions = {
  /** Absolute deadline, in milliseconds, using the same clock as `now`. */
  deadlineMs?: number;
  /** First delay between failed attempts. */
  initialIntervalMs?: number;
  /** Maximum delay between failed attempts after backoff. */
  maxIntervalMs?: number;
  /** Multiplier applied to the interval after each failed attempt. */
  backoffFactor?: number;
  /** Optional cap on condition attempts, including the first immediate check. */
  maxAttempts?: number;
  /** Clock used for deadline comparisons. Defaults to Date.now. */
  now?: () => number;
  /** Sleep function. Defaults to sleepMs for waitUntil and sleepMsAsync for waitUntilAsync. */
  sleep?: (ms: number) => void;
};

type NormalizedWaitUntilOptions = {
  deadlineMs: number;
  intervalMs: number;
  maxIntervalMs: number;
  backoffFactor: number;
  maxAttempts: number;
  hasAttemptCap: boolean;
  now: () => number;
  sleep: (ms: number) => void | Promise<void>;
};

const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_INITIAL_INTERVAL_MS = 250;
const DEFAULT_MAX_INTERVAL_MS = 5_000;
const DEFAULT_BACKOFF_FACTOR = 1.5;
const MIN_UNCAPPED_SLEEP_MS = 1;

/**
 * Build a curl-friendly env that injects NO_PROXY for loopback hosts so that
 * probes against localhost-bound services (Ollama, gateway, dashboard, etc.)
 * do not get routed through a user-configured HTTP_PROXY. See #4181.
 */
export function buildLoopbackProbeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  withLocalNoProxy(env);
  return env;
}

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
 * Asynchronously sleep for the given number of milliseconds.
 */
export function sleepMsAsync(ms: number): Promise<void> {
  if (ms <= 0 || !Number.isFinite(ms)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Synchronously sleep for the given number of seconds.
 */
export function sleepSeconds(seconds: number): void {
  sleepMs(seconds * 1000);
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeFiniteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeWaitUntilOptions(
  optionsOrTimeout?: WaitUntilOptions | number,
  pollIntervalMs = DEFAULT_INITIAL_INTERVAL_MS,
  defaultSleep: (ms: number) => void | Promise<void> = sleepMs,
): NormalizedWaitUntilOptions {
  if (typeof optionsOrTimeout === "number" || optionsOrTimeout === undefined) {
    const now = Date.now;
    const timeoutSeconds =
      optionsOrTimeout === undefined
        ? DEFAULT_TIMEOUT_SECONDS
        : nonNegativeFiniteOr(optionsOrTimeout, DEFAULT_TIMEOUT_SECONDS);
    const currentMs = now();
    const pollMs = nonNegativeFiniteOr(pollIntervalMs, DEFAULT_INITIAL_INTERVAL_MS);
    return {
      deadlineMs: Number.isFinite(currentMs)
        ? currentMs + timeoutSeconds * 1000
        : Number.NEGATIVE_INFINITY,
      intervalMs: pollMs,
      maxIntervalMs: pollMs,
      backoffFactor: 1,
      maxAttempts: Number.POSITIVE_INFINITY,
      hasAttemptCap: false,
      now,
      sleep: defaultSleep,
    };
  }

  const now = optionsOrTimeout.now ?? Date.now;
  const maxIntervalMs = nonNegativeFiniteOr(
    optionsOrTimeout.maxIntervalMs,
    DEFAULT_MAX_INTERVAL_MS,
  );
  const maxAttempts =
    optionsOrTimeout.maxAttempts !== undefined && Number.isFinite(optionsOrTimeout.maxAttempts)
      ? Math.max(0, Math.floor(optionsOrTimeout.maxAttempts))
      : Number.POSITIVE_INFINITY;
  const hasAttemptCap = Number.isFinite(maxAttempts);
  const deadlineMs =
    optionsOrTimeout.deadlineMs === undefined
      ? Number.POSITIVE_INFINITY
      : Number(optionsOrTimeout.deadlineMs);

  if (Number.isNaN(deadlineMs) || deadlineMs === Number.NEGATIVE_INFINITY) {
    throw new TypeError("waitUntil requires a valid deadlineMs");
  }
  if (deadlineMs === Number.POSITIVE_INFINITY && !hasAttemptCap) {
    throw new TypeError("waitUntil requires deadlineMs or maxAttempts");
  }

  return {
    deadlineMs,
    intervalMs: Math.min(
      nonNegativeFiniteOr(optionsOrTimeout.initialIntervalMs, DEFAULT_INITIAL_INTERVAL_MS),
      maxIntervalMs,
    ),
    maxIntervalMs,
    backoffFactor: Math.max(
      1,
      positiveFiniteOr(optionsOrTimeout.backoffFactor, DEFAULT_BACKOFF_FACTOR),
    ),
    maxAttempts,
    hasAttemptCap,
    now,
    sleep: optionsOrTimeout.sleep ?? defaultSleep,
  };
}

function boundedSleepDurationMs(
  intervalMs: number,
  remainingMs: number,
  hasAttemptCap: boolean,
): number {
  const requestedSleepMs = Math.min(intervalMs, remainingMs);
  const sleepDurationMs =
    !hasAttemptCap && requestedSleepMs <= 0 ? MIN_UNCAPPED_SLEEP_MS : requestedSleepMs;
  return Math.min(sleepDurationMs, remainingMs);
}

/**
 * Synchronously wait until a condition is met.
 */
export function waitUntil(conditionFn: () => boolean): boolean;
export function waitUntil(conditionFn: () => boolean, options: WaitUntilOptions): boolean;
export function waitUntil(
  conditionFn: () => boolean,
  timeoutSeconds?: number,
  pollIntervalMs?: number,
): boolean;
export function waitUntil(
  conditionFn: () => boolean,
  optionsOrTimeout?: WaitUntilOptions | number,
  pollIntervalMs?: number,
): boolean {
  const options = normalizeWaitUntilOptions(optionsOrTimeout, pollIntervalMs);
  let attempts = 0;
  let intervalMs = options.intervalMs;

  for (;;) {
    const currentMs = options.now();
    if (!Number.isFinite(currentMs) || currentMs >= options.deadlineMs) {
      return false;
    }
    if (attempts >= options.maxAttempts) {
      return false;
    }
    attempts += 1;

    if (conditionFn()) return true;
    if (attempts >= options.maxAttempts) {
      return false;
    }

    const postConditionMs = options.now();
    if (!Number.isFinite(postConditionMs) || postConditionMs >= options.deadlineMs) {
      return false;
    }
    options.sleep(
      boundedSleepDurationMs(
        intervalMs,
        options.deadlineMs - postConditionMs,
        options.hasAttemptCap,
      ),
    );
    intervalMs = Math.min(options.maxIntervalMs, intervalMs * options.backoffFactor);
  }
}

/**
 * Asynchronously wait until a condition is met.
 */
export function waitUntilAsync(conditionFn: () => boolean | Promise<boolean>): Promise<boolean>;
export function waitUntilAsync(
  conditionFn: () => boolean | Promise<boolean>,
  options: WaitUntilOptions,
): Promise<boolean>;
export function waitUntilAsync(
  conditionFn: () => boolean | Promise<boolean>,
  timeoutSeconds?: number,
  pollIntervalMs?: number,
): Promise<boolean>;
export async function waitUntilAsync(
  conditionFn: () => boolean | Promise<boolean>,
  optionsOrTimeout?: WaitUntilOptions | number,
  pollIntervalMs?: number,
): Promise<boolean> {
  const options = normalizeWaitUntilOptions(optionsOrTimeout, pollIntervalMs, sleepMsAsync);
  let attempts = 0;
  let intervalMs = options.intervalMs;

  for (;;) {
    const currentMs = options.now();
    if (!Number.isFinite(currentMs) || currentMs >= options.deadlineMs) {
      return false;
    }
    if (attempts >= options.maxAttempts) {
      return false;
    }
    attempts += 1;

    if (await conditionFn()) return true;
    if (attempts >= options.maxAttempts) {
      return false;
    }

    const postConditionMs = options.now();
    if (!Number.isFinite(postConditionMs) || postConditionMs >= options.deadlineMs) {
      return false;
    }
    await options.sleep(
      boundedSleepDurationMs(
        intervalMs,
        options.deadlineMs - postConditionMs,
        options.hasAttemptCap,
      ),
    );
    intervalMs = Math.min(options.maxIntervalMs, intervalMs * options.backoffFactor);
  }
}

// One-shot TCP reachability probe, evaluated in a short-lived Node subprocess.
// Used as a fallback when `nc` is not installed. The port is passed as argv
// (process.argv[1]) rather than interpolated into the script, so it can never
// be treated as code. Exit 0 = connected, 1 = refused or timed out.
const TCP_PROBE_SCRIPT =
  "const p=Number(process.argv[1]);" +
  "const s=require('node:net').connect({host:'127.0.0.1',port:p}," +
  "()=>{s.destroy();process.exit(0);});" +
  "s.on('error',()=>process.exit(1));" +
  "s.setTimeout(1000,()=>{s.destroy();process.exit(1);});";

/**
 * Synchronously wait for a TCP port to become reachable on localhost.
 *
 * Prefers `nc -z`, but falls back to a short-lived Node subprocess that opens a
 * TCP connection when `nc` is not installed (minimal Linux distros such as
 * CachyOS, and Windows). Previously a missing `nc` made every probe fail
 * silently, surfacing as a misleading "did not become ready within timeout".
 * See #4974.
 */
export function waitForPort(port: number, timeoutSeconds = 5): boolean {
  const { spawnSync } = require("node:child_process");
  return waitUntil(
    () => {
      try {
        const nc = spawnSync("nc", ["-z", "127.0.0.1", String(port)], { stdio: "ignore" });
        // If nc actually ran, trust its verdict. If nc is missing it returns
        // ENOENT (error set, status null) -- fall back to a Node-based probe
        // rather than reporting the port unreachable.
        if (nc.error == null && typeof nc.status === "number") {
          return nc.status === 0;
        }
        const probe = spawnSync(process.execPath, ["-e", TCP_PROBE_SCRIPT, String(port)], {
          stdio: "ignore",
          timeout: 2000,
        });
        return probe.status === 0;
      } catch {
        return false;
      }
    },
    timeoutSeconds,
    200,
  );
}

/**
 * Synchronously wait for an HTTP endpoint to return a success status code.
 */
export function waitForHttp(url: string, timeoutSeconds = 5): boolean {
  const { spawnSync } = require("node:child_process");
  const env = buildLoopbackProbeEnv();
  return waitUntil(
    () => {
      try {
        const result = spawnSync(
          "curl",
          buildValidatedCurlCommandArgs(["-sf", "--connect-timeout", "1", "--max-time", "1", url]),
          { stdio: "ignore", env },
        );
        return result.status === 0;
      } catch {
        return false;
      }
    },
    timeoutSeconds,
    200,
  );
}
