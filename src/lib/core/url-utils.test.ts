// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import source directly so tests cannot pass against a stale build.
import {
  canonicalEndpoint,
  compactText,
  endpointUrlHasUserinfoQueryOrFragment,
  formatEnvAssignment,
  isLoopbackHostname,
  isLoopbackRemoteAddress,
  normalizeProviderBaseUrl,
  parsePolicyPresetEnv,
  stripEndpointSuffix,
  unsafeEndpointUrlViolation,
} from "./url-utils";

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

describe("canonicalEndpoint", () => {
  it.each([null, undefined] as const)("rejects missing endpoint %s", (input) => {
    expect(canonicalEndpoint(input, "openai")).toBeNull();
  });

  it("rejects non-HTTP(S) protocols", () => {
    expect(canonicalEndpoint("ftp://proxy.example.com/v1", "openai")).toBeNull();
  });

  it.each(["https://user@proxy.example.com/v1", "https://user:password@proxy.example.com/v1"])(
    "rejects URL credentials in %s",
    (input) => {
      expect(canonicalEndpoint(input, "openai")).toBeNull();
    },
  );

  it("accepts the 2048-character bound and rejects longer endpoints", () => {
    const prefix = "https://example.com/";
    const atLimit = `${prefix}${"a".repeat(2048 - prefix.length)}`;
    expect(atLimit).toHaveLength(2048);
    expect(canonicalEndpoint(atLimit, "openai")).toBe(atLimit);
    expect(canonicalEndpoint(`${atLimit}a`, "openai")).toBeNull();
  });

  it.each([
    [
      "OpenAI path",
      "https://proxy.example.com/v1/chat/completions?region=west#fragment",
      "openai",
      "https://proxy.example.com/v1",
    ],
    [
      "Anthropic path",
      "https://proxy.example.com/v1/messages?region=west#fragment",
      "anthropic",
      "https://proxy.example.com",
    ],
  ] as const)("normalizes %s", (_label, input, flavor, expected) => {
    expect(canonicalEndpoint(input, flavor)).toBe(expected);
  });
});

describe("endpointUrlHasUserinfoQueryOrFragment", () => {
  it.each([
    ["query string", "http://127.0.0.1:8000/v1/custom-path?param=value", true],
    ["fragment", "https://proxy.example.com/v1#fragment", true],
    ["userinfo", "https://user:password@proxy.example.com/v1", true],
    ["username only", "https://user@proxy.example.com/v1", true],
    ["empty userinfo delimiter", "http://@example.test/v1", true],
    ["userinfo without slashes", "https:user:password@proxy.example.com/v1", true],
    ["userinfo after one slash", "https:/user:password@proxy.example.com/v1", true],
    ["userinfo after backslashes", "https:\\\\user:password@proxy.example.com/v1", true],
    ["empty userinfo after one slash", "https:/@example.test/v1", true],
    ["empty userinfo after extra slashes", "https:////@example.test/v1", true],
    ["at sign in the path", "https://example.com/v1/@user", false],
    ["scheme-less userinfo", "user:password@proxy.example.com/v1", true],
    ["scheme-less userinfo with query", "user:password@proxy.example.com/v1?x=1", true],
    ["userinfo in an unparseable URL", "https://user:password@proxy example.com/v1", true],
    ["userinfo with invalid percent-encoding", "https://user:password@proxy.example.com/%ZZ", true],
    ["bare trailing query delimiter", "https://proxy.example.com/v1?", true],
    ["bare trailing fragment delimiter", "https://proxy.example.com/v1#", true],
    ["clean base URL with path", "http://127.0.0.1:8000/v1/custom-path", false],
    ["clean origin", "https://proxy.example.com", false],
    ["unparseable input with a query", "not a url ?x=1", true],
    ["unparseable input without a query", "not a url", false],
    ["empty input", "", false],
    ["whitespace input", "   ", false],
  ] as const)("classifies %s (#9106)", (_label, input, expected) => {
    expect(endpointUrlHasUserinfoQueryOrFragment(input)).toBe(expected);
  });
});

describe("unsafeEndpointUrlViolation", () => {
  it.each([
    ["backtick command substitution", "http://127.0.0.1:8000/v1`whoami`", "unsupported-characters"],
    ["dollar command substitution", "http://127.0.0.1:8000/v1$(id)", "unsupported-characters"],
    ["semicolon in the path", "https://example.test/v1;id", "unsupported-characters"],
    ["pipe in the path", "https://example.test/v1|cat", "unsupported-characters"],
    ["ampersand in the path", "https://example.test/v1&x", "unsupported-characters"],
    ["double quote", 'https://example.test/v1"q"', "unsupported-characters"],
    ["single quote", "https://example.test/v1'q'", "unsupported-characters"],
    ["interior space", "https://example.test/v 1", "unsupported-characters"],
    ["encoded newline", "https://example.test/v1%0ainjected", "encoded-control-characters"],
    [
      "encoded carriage return uppercase",
      "https://example.test/v1%0Dx",
      "encoded-control-characters",
    ],
    ["encoded NUL", "https://example.test/v1%00x", "encoded-control-characters"],
    ["encoded UTF-8 C1 control", "https://example.test/v1%C2%80x", "encoded-control-characters"],
    [
      "encoded UTF-8 zero-width space",
      "https://example.test/v1%E2%80%8Bx",
      "encoded-control-characters",
    ],
    ["raw tab", "https://example.test/v\t1", "control-characters"],
    ["raw newline", "https://example.test/v\n1", "control-characters"],
    ["leading tab", "\thttps://example.test/v1", "control-characters"],
    ["trailing tab", "https://example.test/v1\t", "control-characters"],
    ["leading newline", "\nhttps://example.test/v1", "control-characters"],
    ["trailing newline", "https://example.test/v1\n", "control-characters"],
    ["leading no-break space", "\u00a0https://example.test/v1", "unsupported-characters"],
    ["trailing ogham space mark", "https://example.test/v1\u1680", "unsupported-characters"],
    ["leading en quad", "\u2000https://example.test/v1", "unsupported-characters"],
    ["trailing line separator", "https://example.test/v1\u2028", "unsupported-characters"],
    ["leading paragraph separator", "\u2029https://example.test/v1", "unsupported-characters"],
    ["query string", "http://127.0.0.1:8000/v1?param=value", "userinfo-query-fragment"],
    ["userinfo", "https://user:password@example.test/v1", "userinfo-query-fragment"],
    ["non-HTTP scheme", "ftp://example.test/v1", "unsupported-protocol"],
    ["scheme-less host and port", "localhost:8000/v1", "unsupported-protocol"],
    ["scheme-less host path", "example.test/v1", "invalid-url"],
    ["non-ASCII host", "https://exämple.test/v1", "unsupported-characters"],
  ] as const)("rejects %s (#9301)", (_label, input, kind) => {
    expect(unsafeEndpointUrlViolation(input)?.kind).toBe(kind);
  });

  it.each([
    ["IPv6 loopback with port", "http://[::1]:8000/v1"],
    ["host with port and deep path", "https://example.test:8443/deep/path-v1"],
    ["path with URL-legal punctuation", "http://example.test/v1_x.y~z"],
    ["percent-encoded space in the path", "https://example.test/v1/a%20b"],
    ["clean origin", "https://proxy.example.com"],
    ["empty input", ""],
    ["whitespace input", "   "],
  ] as const)("accepts %s (#9301)", (_label, input) => {
    expect(unsafeEndpointUrlViolation(input)).toBeNull();
  });
});

describe("isLoopbackHostname", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["127.0.0.2", true],
    ["::1", true],
    ["[::1]", true],
    ["example.com", false],
    ["", false],
  ] as const)("classifies %s", (input, expected) => {
    expect(isLoopbackHostname(input)).toBe(expected);
  });

  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["10.40.0.1", false],
    ["192.168.1.5", false],
    ["::ffff:192.168.1.5", false],
    [undefined, false],
    ["", false],
  ] as const)("classifies remote address %s", (input, expected) => {
    expect(isLoopbackRemoteAddress(input)).toBe(expected);
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
