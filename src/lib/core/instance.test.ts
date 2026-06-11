// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NEMOCLAW_INSTANCE,
  isDefaultInstance,
  parseInstanceName,
} from "../../../dist/lib/core/instance";

describe("parseInstanceName", () => {
  const ENV_KEY = "TEST_NEMOCLAW_INSTANCE";
  let previousEnvValue: string | undefined;

  beforeEach(() => {
    previousEnvValue = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (previousEnvValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previousEnvValue;
    }
  });

  it.each([
    ["an unset env var", undefined, DEFAULT_NEMOCLAW_INSTANCE],
    ["an empty env var", "", DEFAULT_NEMOCLAW_INSTANCE],
    ["surrounding whitespace then empty", "   ", DEFAULT_NEMOCLAW_INSTANCE],
    ["a valid lower-case slug", "agent-a", "agent-a"],
    ["a numeric tail", "tenant1", "tenant1"],
    ["mixed case input is normalised", "Agent-B", "agent-b"],
    ["trims surrounding whitespace", "  primary  ", "primary"],
    ["a single character", "a", "a"],
    ["the maximum length", "a".repeat(32), "a".repeat(32)],
  ] as const)("parses %s", (_label, value, expected) => {
    if (value !== undefined) {
      process.env[ENV_KEY] = value;
    }

    expect(parseInstanceName(ENV_KEY, DEFAULT_NEMOCLAW_INSTANCE)).toBe(expected);
  });

  it.each([
    ["leading hyphen", "-foo"],
    ["trailing hyphen", "foo-"],
    ["double hyphen-only", "--"],
    ["whitespace inside", "agent a"],
    ["filesystem separator", "agent/a"],
    ["dot separator", "agent.a"],
    ["underscore", "agent_a"],
    ["unicode", "agentü"],
    ["overlong slug", "a".repeat(33)],
  ] as const)("rejects %s", (_label, value) => {
    process.env[ENV_KEY] = value;
    expect(() => parseInstanceName(ENV_KEY, DEFAULT_NEMOCLAW_INSTANCE)).toThrow(
      /Invalid instance name/,
    );
  });

  it.each([
    ["a pure-digit name", "8081"],
    ["a port-like trailing segment", "agent-8081"],
    ["a port-like leading segment", "8081-agent"],
    ["a port-like middle segment", "agent-1-instance"],
    ["a short numeric tail", "tenant-1"],
  ] as const)("rejects %s as a port-suffix collision risk", (_label, value) => {
    process.env[ENV_KEY] = value;
    expect(() => parseInstanceName(ENV_KEY, DEFAULT_NEMOCLAW_INSTANCE)).toThrow(
      /hyphen-separated segments may not be purely numeric/,
    );
  });

  it.each([
    ["a name with a mixed alphanumeric segment", "agent-a1"],
    ["a name leading with a digit", "1agent"],
    ["a name with a number embedded in a segment", "tenant1"],
  ] as const)("still accepts %s (no purely-numeric segment)", (_label, value) => {
    process.env[ENV_KEY] = value;
    expect(parseInstanceName(ENV_KEY, DEFAULT_NEMOCLAW_INSTANCE)).toBe(value);
  });

  it("falls back to a non-default fallback when the env var is unset", () => {
    expect(parseInstanceName(ENV_KEY, "primary")).toBe("primary");
  });

  it("treats an explicit NEMOCLAW_INSTANCE=nemoclaw as the default", () => {
    process.env[ENV_KEY] = "nemoclaw";
    const resolved = parseInstanceName(ENV_KEY, DEFAULT_NEMOCLAW_INSTANCE);
    expect(resolved).toBe(DEFAULT_NEMOCLAW_INSTANCE);
    expect(isDefaultInstance(resolved)).toBe(true);
  });

  it("normalises uppercase NEMOCLAW to the default instance", () => {
    process.env[ENV_KEY] = "NEMOCLAW";
    const resolved = parseInstanceName(ENV_KEY, DEFAULT_NEMOCLAW_INSTANCE);
    expect(resolved).toBe(DEFAULT_NEMOCLAW_INSTANCE);
    expect(isDefaultInstance(resolved)).toBe(true);
  });
});

describe("isDefaultInstance", () => {
  it("recognises the default instance name as `nemoclaw`", () => {
    expect(DEFAULT_NEMOCLAW_INSTANCE).toBe("nemoclaw");
    expect(isDefaultInstance("nemoclaw")).toBe(true);
    expect(isDefaultInstance(DEFAULT_NEMOCLAW_INSTANCE)).toBe(true);
  });

  it("rejects any other name", () => {
    expect(isDefaultInstance("agent-a")).toBe(false);
    expect(isDefaultInstance("")).toBe(false);
    expect(isDefaultInstance("primary")).toBe(false);
    expect(isDefaultInstance("default")).toBe(false);
  });
});
