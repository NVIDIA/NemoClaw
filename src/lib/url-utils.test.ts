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
} from "../../dist/lib/url-utils";

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
  it("strips OpenAI suffixes", () => {
    expect(normalizeProviderBaseUrl("https://api.openai.com/v1/chat/completions", "openai")).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("strips Anthropic suffixes", () => {
    expect(normalizeProviderBaseUrl("https://api.anthropic.com/v1/messages", "anthropic")).toBe(
      "https://api.anthropic.com",
    );
  });

  it("strips trailing slashes", () => {
    expect(normalizeProviderBaseUrl("https://example.com/v1/", "openai")).toBe(
      "https://example.com/v1",
    );
  });

  it("returns origin for root path", () => {
    expect(normalizeProviderBaseUrl("https://example.com/", "openai")).toBe(
      "https://example.com",
    );
  });

  it("handles empty input", () => {
    expect(normalizeProviderBaseUrl("", "openai")).toBe("");
  });

  it("handles invalid URL gracefully", () => {
    expect(normalizeProviderBaseUrl("not-a-url", "openai")).toBe("not-a-url");
  });
});

describe("isLoopbackHostname", () => {
  it("matches localhost", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
  });

  it("matches 127.0.0.1", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  });

  it("matches ::1", () => {
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  it("matches bracketed IPv6", () => {
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("rejects external hostname", () => {
    expect(isLoopbackHostname("example.com")).toBe(false);
  });

  it("handles empty input", () => {
    expect(isLoopbackHostname("")).toBe(false);
  });
});

describe("formatEnvAssignment", () => {
  it("formats name=value", () => {
    expect(formatEnvAssignment("FOO", "bar")).toBe("FOO=bar");
  });
});

describe("parsePolicyPresetEnv", () => {
  it("parses comma-separated values", () => {
    expect(parsePolicyPresetEnv("web,local-inference")).toEqual(["web", "local-inference"]);
  });

  it("trims whitespace", () => {
    expect(parsePolicyPresetEnv(" web , local ")).toEqual(["web", "local"]);
  });

  it("filters empty segments", () => {
    expect(parsePolicyPresetEnv("web,,local")).toEqual(["web", "local"]);
  });

  it("handles empty string", () => {
    expect(parsePolicyPresetEnv("")).toEqual([]);
  });
});
