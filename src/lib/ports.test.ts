// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { parsePort } from "../../dist/lib/ports";

describe("parsePort", () => {
  const ENV_KEY = "TEST_PORT";

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("returns fallback when env var is unset", () => {
    expect(parsePort(ENV_KEY, 8080)).toBe(8080);
  });

  it("returns fallback when env var is empty", () => {
    process.env[ENV_KEY] = "";
    expect(parsePort(ENV_KEY, 8080)).toBe(8080);
  });

  it("parses a valid port", () => {
    process.env[ENV_KEY] = "9000";
    expect(parsePort(ENV_KEY, 8080)).toBe(9000);
  });

  it("trims whitespace", () => {
    process.env[ENV_KEY] = "  3000  ";
    expect(parsePort(ENV_KEY, 8080)).toBe(3000);
  });

  it("rejects non-numeric input", () => {
    process.env[ENV_KEY] = "abc";
    expect(() => parsePort(ENV_KEY, 8080)).toThrow("Invalid port");
  });

  it("rejects mixed alphanumeric input", () => {
    process.env[ENV_KEY] = "80a80";
    expect(() => parsePort(ENV_KEY, 8080)).toThrow("Invalid port");
  });

  it("rejects port below 1024", () => {
    process.env[ENV_KEY] = "80";
    expect(() => parsePort(ENV_KEY, 8080)).toThrow("1024 and 65535");
  });

  it("rejects port above 65535", () => {
    process.env[ENV_KEY] = "70000";
    expect(() => parsePort(ENV_KEY, 8080)).toThrow("1024 and 65535");
  });

  it("accepts port 1024 (lower bound)", () => {
    process.env[ENV_KEY] = "1024";
    expect(parsePort(ENV_KEY, 8080)).toBe(1024);
  });

  it("accepts port 65535 (upper bound)", () => {
    process.env[ENV_KEY] = "65535";
    expect(parsePort(ENV_KEY, 8080)).toBe(65535);
  });

  it("rejects special characters that could break pgrep patterns", () => {
    process.env[ENV_KEY] = ".*";
    expect(() => parsePort(ENV_KEY, 8080)).toThrow("Invalid port");
  });
});
