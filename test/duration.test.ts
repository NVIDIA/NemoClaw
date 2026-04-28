// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { parseDuration, MAX_SECONDS, DEFAULT_SECONDS } from "../src/lib/duration.js";

describe("parseDuration", () => {
  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("1m")).toBe(60);
  });

  it("parses seconds", () => {
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("1800s")).toBe(1800);
  });

  it("rejects hours that exceed max", () => {
    expect(() => parseDuration("1h")).toThrow("exceeds maximum"); // 3600 > 1800
  });

  it("rejects non-integer hour values", () => {
    expect(() => parseDuration("0.5h")).toThrow("Invalid duration");
  });

  it("treats bare numbers as seconds", () => {
    expect(parseDuration("300")).toBe(300);
    expect(parseDuration("1800")).toBe(1800);
  });

  it("trims whitespace", () => {
    expect(parseDuration("  5m  ")).toBe(300);
  });

  it("is case-insensitive", () => {
    expect(parseDuration("5M")).toBe(300);
    expect(parseDuration("90S")).toBe(90);
  });

  it("rejects empty input", () => {
    expect(() => parseDuration("")).toThrow("Duration cannot be empty");
    expect(() => parseDuration("   ")).toThrow("Duration cannot be empty");
  });

  it("rejects non-numeric input", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
    expect(() => parseDuration("five minutes")).toThrow("Invalid duration");
  });

  it("rejects zero duration", () => {
    expect(() => parseDuration("0s")).toThrow("greater than zero");
    expect(() => parseDuration("0m")).toThrow("greater than zero");
  });

  it("rejects durations exceeding 30 minutes", () => {
    expect(() => parseDuration("31m")).toThrow("exceeds maximum");
    expect(() => parseDuration("1801")).toThrow("exceeds maximum");
    expect(() => parseDuration("1h")).toThrow("exceeds maximum");
  });

  it("accepts exactly 30 minutes", () => {
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("1800s")).toBe(1800);
    expect(parseDuration("1800")).toBe(1800);
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
