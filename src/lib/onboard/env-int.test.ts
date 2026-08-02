// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// `envInt` backs the poll counts, poll intervals and readiness budgets used
// across onboarding and gateway recovery. A negative override used to be
// clamped to 0, which is the most damaging reading available for every one of
// those knobs, while any other invalid value already fell back (#7881).

import { describe, expect, it, vi } from "vitest";

import { envInt } from "./env";

const FALLBACK = 30;

function read(value: string | undefined): number {
  return envInt("NEMOCLAW_TEST_KNOB", FALLBACK, { NEMOCLAW_TEST_KNOB: value });
}

describe("envInt override parsing", () => {
  it.each([
    "-1",
    "-30",
    "-0.4",
    "-1e3",
  ])("falls back instead of collapsing a negative override (%s) to zero", (value) => {
    expect(read(value)).toBe(FALLBACK);
  });

  it.each([
    "abc",
    "NaN",
    "Infinity",
    "-Infinity",
  ])("keeps falling back for a non-finite override (%s)", (value) => {
    expect(read(value)).toBe(FALLBACK);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("keeps falling back for an %s override", (_label, value) => {
    expect(read(value)).toBe(FALLBACK);
  });

  it("still accepts an explicit zero", () => {
    // Regression lock: callers that read 0 as "disabled" or clamp it upward
    // themselves must keep seeing 0, so this fix cannot change their meaning.
    expect(read("0")).toBe(0);
  });

  it.each([
    ["3", 3],
    ["0.4", 0],
    ["2.6", 3],
    ["600", 600],
  ])("keeps rounding a valid override (%s)", (value, expected) => {
    expect(read(value)).toBe(expected);
  });

  it("uses the supplied env map rather than the process environment", () => {
    // Both assertions need a conflicting process value to have any teeth: with
    // `process.env` unset, an implementation that ignored the supplied map
    // would return the fallback here and still pass.
    vi.stubEnv("NEMOCLAW_TEST_KNOB", "999");
    try {
      expect(envInt("NEMOCLAW_TEST_KNOB", FALLBACK, { NEMOCLAW_TEST_KNOB: "7" })).toBe(7);
      expect(envInt("NEMOCLAW_TEST_KNOB", FALLBACK, {})).toBe(FALLBACK);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
