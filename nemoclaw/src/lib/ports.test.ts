// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parsePort } from "./ports.js";

const ENV_KEY = "TEST_PLUGIN_PORT";

function clearEnv(): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete process.env[ENV_KEY];
}

describe("parsePort (plugin)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("returns fallback when unset", () => {
    expect(parsePort(ENV_KEY, 18789)).toBe(18789);
  });

  it("returns fallback when empty", () => {
    process.env[ENV_KEY] = "";
    expect(parsePort(ENV_KEY, 18789)).toBe(18789);
  });

  it("parses valid port", () => {
    process.env[ENV_KEY] = "9000";
    expect(parsePort(ENV_KEY, 18789)).toBe(9000);
  });

  it("trims whitespace", () => {
    process.env[ENV_KEY] = "  3000  ";
    expect(parsePort(ENV_KEY, 18789)).toBe(3000);
  });

  it("rejects non-numeric", () => {
    process.env[ENV_KEY] = "abc";
    expect(() => parsePort(ENV_KEY, 18789)).toThrow("Invalid port");
  });

  it("rejects below 1024", () => {
    process.env[ENV_KEY] = "80";
    expect(() => parsePort(ENV_KEY, 18789)).toThrow("1024 and 65535");
  });

  it("rejects above 65535", () => {
    process.env[ENV_KEY] = "70000";
    expect(() => parsePort(ENV_KEY, 18789)).toThrow("1024 and 65535");
  });

  it("accepts 1024", () => {
    process.env[ENV_KEY] = "1024";
    expect(parsePort(ENV_KEY, 18789)).toBe(1024);
  });

  it("accepts 65535", () => {
    process.env[ENV_KEY] = "65535";
    expect(parsePort(ENV_KEY, 18789)).toBe(65535);
  });
});
