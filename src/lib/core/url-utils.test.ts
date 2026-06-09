// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  compactText,
  stripEndpointSuffix,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} from "../../../dist/lib/core/url-utils";

describe("compactText", () => {
  it("collapses whitespace", () => {
    expect(compactText("  hello   world  ")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(compactText("")).toBe("");
  });
});

describe("stripEndpointSuffix", () => {
  it("strips matching suffix", () => {
    expect(stripEndpointSuffix("/v1/chat/completions", ["/chat/completions"])).toBe("/v1");
  });

  it("returns empty for exact match", () => {
    expect(stripEndpointSuffix("/v1", ["/v1"])).toBe("");
  });

  it("returns pathname when no suffix matches", () => {
    expect(stripEndpointSuffix("/api/foo", ["/v1"])).toBe("/api/foo");
  });
});

describe("normalizeProviderBaseUrl", () => {
  it.each([
    [
      "OpenAI suffix",
      "https://api.openai.com/v1/chat/completions",
      "openai",
      "https://api.openai.com/v1",
    ],
    [
      "Anthropic messages suffix",
      "https://api.anthropic.com/v1/messages",
      "anthropic",
      "https://api.anthropic.com",
    ],
    [
      "Anthropic v1 suffix",
      "https://proxy.example.com/v1",
      "anthropic",
      "https://proxy.example.com",
    ],
    [
      "proxied Anthropic messages suffix",
      "https://proxy.example.com/v1/messages",
      "anthropic",
      "https://proxy.example.com",
    ],
    ["trailing slashes", "https://example.com/v1/", "openai", "https://example.com/v1"],
    ["root path", "https://example.com/", "openai", "https://example.com"],
    ["empty input", "", "openai", ""],
    ["invalid URL", "not-a-url", "openai", "not-a-url"],
  ] as const)("normalizes %s", (_label, input, provider, expected) => {
    expect(normalizeProviderBaseUrl(input, provider)).toBe(expected);
  });
});

describe("isLoopbackHostname", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["::1", true],
    ["[::1]", true],
    ["example.com", false],
    ["", false],
  ] as const)("classifies %s", (input, expected) => {
    expect(isLoopbackHostname(input)).toBe(expected);
  });
});

describe("formatEnvAssignment", () => {
  it("formats name=value", () => {
    expect(formatEnvAssignment("FOO", "bar")).toBe("FOO=bar");
  });
});

describe("parsePolicyPresetEnv", () => {
  it.each([
    ["comma-separated values", "web,local-inference", ["web", "local-inference"]],
    ["whitespace", " web , local ", ["web", "local"]],
    ["empty segments", "web,,local", ["web", "local"]],
    ["empty string", "", []],
  ] as const)("parses %s", (_label, input, expected) => {
    expect(parsePolicyPresetEnv(input)).toEqual(expected);
  });
});
