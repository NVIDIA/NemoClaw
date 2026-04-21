// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert";
import { describe, expect, it } from "vitest";
import { sleepMs, sleepSeconds } from "../src/lib/wait.js";

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
});
