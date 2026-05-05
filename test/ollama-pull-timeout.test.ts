// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { getOllamaPullTimeoutMs } from "../dist/lib/onboard-ollama-proxy.js";

const ENV = "NEMOCLAW_OLLAMA_PULL_TIMEOUT";
const DEFAULT_MS = 30 * 60 * 1000;

describe("getOllamaPullTimeoutMs", () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("falls back to the 30-minute default when the env var is unset", () => {
    delete process.env[ENV];
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
  });

  it("falls back to the default when the env var is empty or whitespace", () => {
    process.env[ENV] = "";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
    process.env[ENV] = "   ";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
  });

  it("converts a positive integer seconds value to milliseconds", () => {
    process.env[ENV] = "1800";
    expect(getOllamaPullTimeoutMs()).toBe(1_800_000);
  });

  it("truncates fractional second inputs", () => {
    process.env[ENV] = "1.5";
    expect(getOllamaPullTimeoutMs()).toBe(1_500);
  });

  it("falls back to the default for non-numeric values", () => {
    process.env[ENV] = "thirty-minutes";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
  });

  it("falls back to the default for zero or negative values", () => {
    process.env[ENV] = "0";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
    process.env[ENV] = "-60";
    expect(getOllamaPullTimeoutMs()).toBe(DEFAULT_MS);
  });
});
