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

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
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

  it("falls back to a non-default fallback when the env var is unset", () => {
    expect(parseInstanceName(ENV_KEY, "primary")).toBe("primary");
  });
});

describe("isDefaultInstance", () => {
  it("recognises the default instance", () => {
    expect(isDefaultInstance(DEFAULT_NEMOCLAW_INSTANCE)).toBe(true);
  });

  it("rejects any other name", () => {
    expect(isDefaultInstance("agent-a")).toBe(false);
    expect(isDefaultInstance("")).toBe(false);
    expect(isDefaultInstance("primary")).toBe(false);
  });
});
