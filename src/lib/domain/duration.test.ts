// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { parseDuration, MAX_SECONDS, DEFAULT_SECONDS } from "./duration";

describe("parseDuration", () => {
  it.each([
    ["5m", 300],
    ["30m", 1800],
    ["1m", 60],
    ["90s", 90],
    ["1800s", 1800],
    ["300", 300],
    ["1800", 1800],
    ["  5m  ", 300],
    ["5M", 300],
    ["90S", 90],
  ] as const)("parses %s as %i seconds", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each([
    ["empty input", "", "Duration cannot be empty"],
    ["whitespace-only input", "   ", "Duration cannot be empty"],
    ["non-numeric text", "abc", "Invalid duration"],
    ["word-based duration", "five minutes", "Invalid duration"],
    ["non-integer hours", "0.5h", "Invalid duration"],
    ["zero seconds", "0s", "greater than zero"],
    ["zero minutes", "0m", "greater than zero"],
    ["minutes over the maximum", "31m", "exceeds maximum"],
    ["bare seconds over the maximum", "1801", "exceeds maximum"],
    ["hours over the maximum", "1h", "exceeds maximum"],
  ] as const)("rejects %s", (_label, input, expectedMessage) => {
    expect(() => parseDuration(input)).toThrow(expectedMessage);
  });
});

describe("constants", () => {
  it("MAX_SECONDS is 1800 (30 minutes)", () => {
    expect(MAX_SECONDS).toBe(1800);
  });

  it("DEFAULT_SECONDS is 300 (5 minutes)", () => {
    expect(DEFAULT_SECONDS).toBe(300);
  });
});
