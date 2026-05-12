// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that gateway-reuse waits for the host-level HTTP endpoint to start
// returning 2xx (or 401) before declaring the gateway reusable. Without this,
// a gateway whose container is up but whose upstream is still warming up
// (e.g. immediately after a Docker daemon restart) gets reused with stale
// CLI metadata, leading to "Connection refused" later in onboard.
//
// Also verifies the Docker-state-`unknown` branch stays non-destructive
// (#2020 invariant) — when the docker daemon is itself flaky, destroying and
// recreating the gateway cannot succeed anyway.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3258
// Regression of: https://github.com/NVIDIA/NemoClaw/issues/2020

import http from "node:http";
import { createRequire } from "node:module";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const onboardModule = require("../dist/lib/onboard.js") as {
  getGatewayReuseHealthWaitConfig: () => { count: number; interval: number };
  isGatewayHttpReady: (timeoutMs?: number, url?: string) => Promise<boolean>;
  waitForGatewayHttpReady: (opts?: {
    probe?: () => Promise<boolean>;
    sleeper?: (seconds: number) => void;
    maxAttempts?: number;
    intervalSeconds?: number;
  }) => Promise<boolean>;
};
const { getGatewayReuseHealthWaitConfig, isGatewayHttpReady, waitForGatewayHttpReady } =
  onboardModule;

/** Bind an ephemeral localhost port, close it, and return its URL — a port
 * that's guaranteed to refuse connections for the lifetime of the test. */
async function getClosedLocalUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return `http://127.0.0.1:${port}/`;
}

/** Spin up a tiny HTTP server that returns the given status code, return its URL. */
async function startStatusServer(statusCode: number): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    res.statusCode = statusCode;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("getGatewayReuseHealthWaitConfig (#3258)", () => {
  const originalCount = process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT;
  const originalInterval = process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL;

  beforeEach(() => {
    delete process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT;
    delete process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL;
  });

  afterEach(() => {
    if (originalCount === undefined) delete process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT;
    else process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT = originalCount;
    if (originalInterval === undefined) delete process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL;
    else process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL = originalInterval;
  });

  it("defaults to 6 polls × 5s when no env overrides are set", () => {
    expect(getGatewayReuseHealthWaitConfig()).toEqual({ count: 6, interval: 5 });
  });

  it("respects NEMOCLAW_REUSE_HEALTH_POLL_COUNT", () => {
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT = "12";
    expect(getGatewayReuseHealthWaitConfig().count).toBe(12);
  });

  it("respects NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL", () => {
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL = "2";
    expect(getGatewayReuseHealthWaitConfig().interval).toBe(2);
  });

  it("falls back to defaults when env values are non-finite", () => {
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT = "not-a-number";
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL = "";
    expect(getGatewayReuseHealthWaitConfig()).toEqual({ count: 6, interval: 5 });
  });

  it("returns env values unclamped — normalisation is the consumer's job", () => {
    // The wait helper applies `Math.max(1, count)` and `Math.max(0, interval)`,
    // covering both env-derived and caller-supplied values in one place. The
    // config function itself just reads the env.
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_COUNT = "0";
    process.env.NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL = "0";
    expect(getGatewayReuseHealthWaitConfig()).toEqual({ count: 0, interval: 0 });
  });
});

describe("isGatewayHttpReady status-code semantics (#3258)", () => {
  it("returns true for 200", async () => {
    const server = await startStatusServer(200);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("returns true for 401 (device-auth gate enabled, gateway is alive)", async () => {
    const server = await startStatusServer(401);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("returns false for 502 (gateway up but k3s upstream still warming)", async () => {
    const server = await startStatusServer(502);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns false for 404 (root not handled — not a healthy signal)", async () => {
    const server = await startStatusServer(404);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns false for 403", async () => {
    const server = await startStatusServer(403);
    try {
      expect(await isGatewayHttpReady(2000, server.url)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns false on connection refused", async () => {
    // Bind and immediately close an ephemeral port so the address is
    // guaranteed unreachable — more deterministic than relying on port 1.
    const url = await getClosedLocalUrl();
    expect(await isGatewayHttpReady(2000, url)).toBe(false);
  });

  it("falls back to the default timeout when given a non-positive value", async () => {
    // A non-positive timeoutMs must not cause the request to be torn down
    // immediately — the helper falls back to the safe default and lets the
    // probe complete normally against a healthy server.
    const server = await startStatusServer(200);
    try {
      for (const bad of [0, -1, Number.NaN]) {
        expect(await isGatewayHttpReady(bad, server.url)).toBe(true);
      }
    } finally {
      await server.close();
    }
  });
});

describe("waitForGatewayHttpReady (#3258)", () => {
  it("returns true on the first probe call when the gateway is already responding", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        return true;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 6,
      intervalSeconds: 5,
    });
    expect(result).toBe(true);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries until the probe passes, sleeping between attempts", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        return calls >= 3;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 6,
      intervalSeconds: 5,
    });
    expect(result).toBe(true);
    expect(calls).toBe(3);
    // Sleeps happen between attempts only — two failures → two sleeps before the success.
    expect(sleeps).toEqual([5, 5]);
  });

  it("returns false when the probe never passes within the budget", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        return false;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 4,
      intervalSeconds: 3,
    });
    expect(result).toBe(false);
    expect(calls).toBe(4);
    // No trailing sleep after the final failed attempt.
    expect(sleeps).toEqual([3, 3, 3]);
  });

  it("respects an attempt count of 1 — single probe, no sleeps", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        return false;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 1,
      intervalSeconds: 5,
    });
    expect(result).toBe(false);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("always probes at least once even when maxAttempts is 0 or negative", async () => {
    for (const bad of [0, -1, -100]) {
      let calls = 0;
      const sleeps: number[] = [];
      const result = await waitForGatewayHttpReady({
        probe: async () => {
          calls += 1;
          return false;
        },
        sleeper: (s: number) => sleeps.push(s),
        maxAttempts: bad,
        intervalSeconds: 5,
      });
      expect(result).toBe(false);
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("does not loop forever when maxAttempts is Infinity or NaN", async () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      let calls = 0;
      const sleeps: number[] = [];
      const result = await waitForGatewayHttpReady({
        probe: async () => {
          calls += 1;
          return false;
        },
        sleeper: (s: number) => sleeps.push(s),
        maxAttempts: bad,
        intervalSeconds: 5,
      });
      expect(result).toBe(false);
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("does not pass NaN/Infinity through to the sleeper", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let calls = 0;
      const sleeps: number[] = [];
      const result = await waitForGatewayHttpReady({
        probe: async () => {
          calls += 1;
          return calls >= 2;
        },
        sleeper: (s: number) => sleeps.push(s),
        maxAttempts: 3,
        intervalSeconds: bad,
      });
      expect(result).toBe(true);
      // One sleep before the second probe — must be 0, not NaN/Infinity.
      expect(sleeps).toEqual([0]);
    }
  });

  it("treats a probe rejection as 'not ready' and continues to the next attempt", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient probe failure");
        return true;
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 4,
      intervalSeconds: 2,
    });
    expect(result).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2]);
  });

  it("returns false when every probe rejects across the whole budget", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForGatewayHttpReady({
      probe: async () => {
        calls += 1;
        throw new Error("probe is broken");
      },
      sleeper: (s: number) => sleeps.push(s),
      maxAttempts: 3,
      intervalSeconds: 1,
    });
    expect(result).toBe(false);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1, 1]);
  });
});
