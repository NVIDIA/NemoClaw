// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { waitUntil } from "../core/wait";
import {
  createReadinessWaitOptions,
  formatReadinessDeadline,
  getLegacyPollDeadlineBudgetMs,
} from "./readiness-wait";

describe("readiness deadline options", () => {
  it("starts fast, backs off to the cap, and consumes the full deadline", () => {
    let nowMs = 1_000;
    const sleep = vi.fn((ms: number) => {
      nowMs += ms;
    });
    const options = createReadinessWaitOptions({
      budgetMs: 2_000,
      maxIntervalMs: 1_000,
      now: () => nowMs,
      sleep,
    });

    expect(options).not.toBeNull();
    expect(waitUntil(() => false, options!)).toBe(false);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep.mock.calls.every(([ms]) => ms <= 1_000)).toBe(true);
    expect(sleep.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBe(2_000);
  });

  it("honors a slower initial interval for readiness paths with a stability contract", () => {
    const options = createReadinessWaitOptions({
      budgetMs: 10_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 2_000,
    });

    expect(options?.initialIntervalMs).toBe(2_000);
  });

  it("preserves bounded immediate probes for a zero-interval legacy configuration", () => {
    const probe = vi.fn(() => false);
    const options = createReadinessWaitOptions({
      budgetMs: 0,
      maxIntervalMs: 0,
      zeroBudgetAttempts: 3,
      sleep: vi.fn(),
    });

    expect(waitUntil(probe, options!)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("clamps legacy budgets and formats the actual deadline", () => {
    expect(getLegacyPollDeadlineBudgetMs(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(formatReadinessDeadline(250)).toBe("250ms");
    expect(formatReadinessDeadline(2_500)).toBe("2.5s");
  });
});
