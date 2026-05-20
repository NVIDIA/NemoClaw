// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert";
import net from "node:net";
import { describe, it } from "vitest";
import { sleepMs, sleepSeconds, waitForPort } from "../src/lib/core/wait.js";

function listenOnLoopback(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Server did not bind to a numeric port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

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

  it("waitForPort succeeds for an open localhost port", async () => {
    const server = net.createServer();
    const port = await listenOnLoopback(server);
    try {
      assert.equal(waitForPort(port, 1), true);
    } finally {
      await closeServer(server);
    }
  });

  it("waitForPort returns false for a closed localhost port", async () => {
    const server = net.createServer();
    const port = await listenOnLoopback(server);
    await closeServer(server);
    assert.equal(waitForPort(port, 0.6), false);
  });
});
