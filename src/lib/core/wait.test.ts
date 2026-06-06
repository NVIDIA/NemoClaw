// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sleepMs, sleepSeconds, waitForHttp, waitForPort, waitUntil } from "./wait";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

describe("sleepMs", () => {
  it("blocks for approximately the requested duration", () => {
    const start = performance.now();
    sleepMs(50);
    expect(performance.now() - start).toBeGreaterThanOrEqual(50);
  });

  it("returns immediately for zero", () => {
    const start = performance.now();
    sleepMs(0);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("returns immediately for negative values", () => {
    const start = performance.now();
    sleepMs(-100);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("returns immediately for NaN", () => {
    const start = performance.now();
    sleepMs(NaN);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("returns immediately for Infinity", () => {
    const start = performance.now();
    sleepMs(Infinity);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("sleepSeconds", () => {
  it("blocks for approximately the requested number of seconds", () => {
    const start = performance.now();
    sleepSeconds(0.05);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(500);
  });

  it("returns immediately for zero seconds", () => {
    const start = performance.now();
    sleepSeconds(0);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("waitUntil", () => {
  it("returns true immediately when condition is already met", () => {
    expect(waitUntil(() => true, 1, 50)).toBe(true);
  });

  it("returns true when condition becomes true before timeout", () => {
    let calls = 0;
    const result = waitUntil(() => ++calls >= 3, 2, 30);
    expect(result).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("returns false when condition is never met within the timeout", () => {
    expect(waitUntil(() => false, 0.1, 50)).toBe(false);
  });

  it("polls the condition multiple times before timeout", () => {
    const conditionFn = vi.fn(() => false);
    waitUntil(conditionFn, 0.2, 40);
    expect(conditionFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("waitForPort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when nc reports the port is open", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    expect(waitForPort(8080, 1)).toBe(true);
  });

  it("returns false when the port does not open before timeout", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    expect(waitForPort(9999, 0.1)).toBe(false);
  });

  it("returns false when nc throws", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("nc not found");
    });
    expect(waitForPort(8080, 0.1)).toBe(false);
  });
});

describe("waitForHttp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when curl succeeds", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    expect(waitForHttp("http://127.0.0.1:8080/health", 1)).toBe(true);
  });

  it("returns false when the endpoint does not respond before timeout", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    expect(waitForHttp("http://127.0.0.1:9999/health", 0.1)).toBe(false);
  });

  it("returns false when curl throws", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("curl not found");
    });
    expect(waitForHttp("http://127.0.0.1:8080/health", 0.1)).toBe(false);
  });
});
