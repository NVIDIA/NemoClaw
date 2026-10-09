// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import source directly so tests cannot pass against a stale build.
import { MAX_TIMER_DELAY_MS, parseTimerDelayMs } from "./timer";

describe("parseTimerDelayMs", () => {
  it("returns a positive value up to the timer limit", () => {
    expect(parseTimerDelayMs("1")).toBe(1);
    expect(parseTimerDelayMs("15000")).toBe(15000);
    expect(parseTimerDelayMs(String(MAX_TIMER_DELAY_MS))).toBe(MAX_TIMER_DELAY_MS);
  });

  it("returns undefined for a value above the timer limit", () => {
    expect(parseTimerDelayMs(String(MAX_TIMER_DELAY_MS + 1))).toBeUndefined();
    expect(parseTimerDelayMs("Infinity")).toBeUndefined();
  });

  it.each([undefined, "", "0", "-5", "abc", "NaN", "0.5", "1.5"])(
    "returns undefined for %j",
    (raw) => {
      expect(parseTimerDelayMs(raw)).toBeUndefined();
    },
  );
});
