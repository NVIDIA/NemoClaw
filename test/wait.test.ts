// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLoopbackProbeEnv,
  sleepMs,
  sleepSeconds,
  waitForPort,
  waitUntil,
  waitUntilAsync,
} from "../src/lib/core/wait.js";

describe("wait utility", () => {
  it("sleepMs blocks for approximately the requested time", () => {
    const start = performance.now();
    sleepMs(100);
    const end = performance.now();
    const duration = end - start;

    // Allow for some jitter, but should be at least 100ms.
    // Increased upper bound to 500ms to avoid CI flakes on loaded runners.
    assert.ok(duration >= 100, `duration ${duration}ms < 100ms`);
    assert.ok(duration < 500, `duration ${duration}ms > 500ms`);
  });

  it("sleepSeconds blocks for approximately the requested time", () => {
    const start = performance.now();
    sleepSeconds(0.1);
    const end = performance.now();
    const duration = end - start;

    assert.ok(duration >= 100, `duration ${duration}ms < 100ms`);
    assert.ok(duration < 500, `duration ${duration}ms > 500ms`);
  });

  it("returns immediately for zero, negative, or non-finite time", () => {
    const start = performance.now();
    sleepMs(0);
    sleepMs(-50);
    sleepMs(NaN);
    sleepMs(Infinity);
    const end = performance.now();
    const duration = end - start;
    assert.ok(duration < 50, `duration ${duration}ms > 50ms`);
  });

  it("waitUntil returns immediately when the condition is already true", () => {
    const sleeps: number[] = [];
    let attempts = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return true;
      },
      {
        deadlineMs: 100,
        now: () => 0,
        sleep: (ms) => sleeps.push(ms),
      },
    );

    expect(result).toBe(true);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("waitUntil does not probe when the deadline is already expired", () => {
    const sleeps: number[] = [];
    let attempts = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return true;
      },
      {
        deadlineMs: 10,
        now: () => 10,
        sleep: (ms) => sleeps.push(ms),
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it("waitUntil throws when deadlineMs is non-finite and no attempt cap is provided", () => {
    expect(() =>
      waitUntil(() => false, {
        deadlineMs: Number.NaN,
        now: () => 0,
        sleep: () => {},
      }),
    ).toThrow(TypeError);
  });

  it("waitUntil retries until the condition succeeds", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return attempts >= 3;
      },
      {
        deadlineMs: 100,
        initialIntervalMs: 10,
        maxIntervalMs: 10,
        backoffFactor: 1,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(true);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 10]);
  });

  it("waitUntil returns false after the deadline passes", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return false;
      },
      {
        deadlineMs: 25,
        initialIntervalMs: 10,
        maxIntervalMs: 10,
        backoffFactor: 1,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 10, 5]);
  });

  it("waitUntil applies interval backoff up to the configured max interval", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return attempts >= 5;
      },
      {
        deadlineMs: 100,
        initialIntervalMs: 5,
        maxIntervalMs: 20,
        backoffFactor: 2,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(true);
    expect(sleeps).toEqual([5, 10, 20, 20]);
  });

  it("waitUntil can cap attempts while allowing zero-length intervals", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return false;
      },
      {
        deadlineMs: 1,
        initialIntervalMs: 0,
        maxIntervalMs: 0,
        maxAttempts: 3,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([0, 0]);
  });

  it("waitUntil can rely on maxAttempts without a deadline", () => {
    const sleeps: number[] = [];
    let attempts = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return false;
      },
      {
        initialIntervalMs: 0,
        maxIntervalMs: 0,
        maxAttempts: 3,
        now: () => 0,
        sleep: (ms) => sleeps.push(ms),
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([0, 0]);
  });

  it("waitUntil yields between unbounded zero-interval attempts", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return false;
      },
      {
        deadlineMs: 3,
        initialIntervalMs: 0,
        maxIntervalMs: 0,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1, 1, 1]);
  });

  it("waitUntilAsync retries until the async condition succeeds", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = await waitUntilAsync(
      async () => {
        attempts += 1;
        return attempts >= 3;
      },
      {
        initialIntervalMs: 5,
        maxIntervalMs: 5,
        maxAttempts: 4,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(true);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([5, 5]);
  });

  it("waitUntilAsync uses a nonblocking default sleeper", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;

      const resultPromise = waitUntilAsync(
        () => {
          attempts += 1;
          return attempts >= 2;
        },
        {
          initialIntervalMs: 10,
          maxIntervalMs: 10,
          maxAttempts: 2,
        },
      );

      await Promise.resolve();
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(9);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toBe(true);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildLoopbackProbeEnv (#4181)", () => {
  // Regression for #4181: probes against localhost-bound services (Ollama, gateway,
  // dashboard) must not be routed through the user-configured HTTP_PROXY. The env we
  // pass to the curl child process must add localhost/127.0.0.1 to NO_PROXY whenever
  // any proxy variable is set.
  const PROXY_KEYS = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of PROXY_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
  });

  function snapshotAndClear() {
    for (const k of PROXY_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }

  it("leaves NO_PROXY untouched when no HTTP_PROXY is configured", () => {
    snapshotAndClear();
    const env = buildLoopbackProbeEnv();
    assert.strictEqual(env.NO_PROXY, undefined);
    assert.strictEqual(env.no_proxy, undefined);
  });

  it("adds localhost and 127.0.0.1 to NO_PROXY when HTTP_PROXY is set", () => {
    snapshotAndClear();
    process.env.HTTP_PROXY = "http://127.0.0.1:8118";
    process.env.http_proxy = "http://127.0.0.1:8118";
    const env = buildLoopbackProbeEnv();
    for (const key of ["NO_PROXY", "no_proxy"]) {
      const parts = (env[key] ?? "").split(",").map((s) => s.trim());
      assert.ok(parts.includes("localhost"), `${key} missing localhost: ${env[key]}`);
      assert.ok(parts.includes("127.0.0.1"), `${key} missing 127.0.0.1: ${env[key]}`);
    }
  });

  it("preserves existing NO_PROXY entries when augmenting", () => {
    snapshotAndClear();
    process.env.HTTP_PROXY = "http://127.0.0.1:8118";
    process.env.NO_PROXY = "existing-host,internal-host";
    const env = buildLoopbackProbeEnv();
    const parts = new Set((env.NO_PROXY ?? "").split(",").map((s) => s.trim()));
    assert.ok(parts.has("existing-host"), env.NO_PROXY);
    assert.ok(parts.has("internal-host"), env.NO_PROXY);
    assert.ok(parts.has("localhost"), env.NO_PROXY);
    assert.ok(parts.has("127.0.0.1"), env.NO_PROXY);
  });
});

describe("waitForPort (#4974)", () => {
  // Regression for #4974: onboarding probed TCP ports by shelling out to `nc`,
  // which is not installed on many hosts (minimal Linux distros such as CachyOS,
  // and Windows). When nc was missing, every probe failed silently and
  // onboarding aborted with a misleading "did not become ready within timeout".
  // The probe must succeed with no external tools available on PATH.
  it("returns true for a listening port without any external tool on PATH", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const originalPath = process.env.PATH;
    try {
      // Emptying PATH hides nc (and every other binary). process.execPath is an
      // absolute path, so the Node-based probe still runs.
      process.env.PATH = "";
      assert.strictEqual(waitForPort(port, 2), true);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns false when no service is listening", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The port is now closed; the probe should give up within the timeout.
    assert.strictEqual(waitForPort(port, 1), false);
  });
});
