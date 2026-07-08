// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { redact, redactForLog, redactFull, redactSensitiveText, redactUrl } from "./redact.js";

describe("URL redaction", () => {
  it.each([
    ["SOCKS", "socks5://socks-user:socks-password@proxy.example:1080"],
    ["mixed-case FTP", "FtP://ftp-user:ftp-password@files.example/path"],
    ["mixed-case HTTPS", "HTTPS://https-user:https-password@secure.example:8443"],
  ])("redacts embedded credentials from %s URLs", (_label, value) => {
    const result = redact(value);

    expect(result).toContain("****:****@");
    expect(result).not.toContain("-user");
    expect(result).not.toContain("-password");
  });

  it("redacts a bracket-wrapped SOCKS URL without breaking its closing delimiter", () => {
    const result = redact(
      "proxy [socks5://bracket-user:bracket-password@proxy.example:1080] failed",
    );

    expect(result).toContain("socks5://****:****@proxy.example:1080]");
    expect(result).not.toContain("bracket-user");
    expect(result).not.toContain("bracket-password");
  });

  it("bounds malformed wrapper parsing before falling back to userinfo redaction", () => {
    const wrappers = "]".repeat(4_096);
    const result = redact(
      `proxy [socks5://bounded-user:bounded-password@proxy.example:1080${wrappers}`,
    );

    expect(result).toContain("socks5://****:****@proxy.example:1080");
    expect(result).not.toContain("bounded-user");
    expect(result).not.toContain("bounded-password");
  });

  it("preserves a credentialed IPv6 host while redacting its userinfo", () => {
    const result = redact("proxy https://ipv6-user:ipv6-password@[::1]:8443/path failed");

    expect(result).toContain("https://****:****@[::1]:8443/path");
    expect(result).not.toContain("ipv6-user");
    expect(result).not.toContain("ipv6-password");
  });

  it.each([
    [
      "parentheses and comma",
      "proxy (https://wrapped-user:wrapped-password@proxy.example/path), retry",
      "(https://****:****@proxy.example/path), retry",
    ],
    [
      "angle brackets and semicolon",
      "proxy <ftp://wrapped-user:wrapped-password@files.example/path>; retry",
      "<ftp://****:****@files.example/path>; retry",
    ],
    [
      "a trailing sentence period",
      "proxy socks5://wrapped-user:wrapped-password@proxy.example:1080. retry",
      "socks5://****:****@proxy.example:1080. retry",
    ],
  ])("keeps %s outside the redacted URL token", (_label, value, expected) => {
    const result = redact(value);

    expect(result).toContain(expected);
    expect(result).not.toContain("wrapped-user");
    expect(result).not.toContain("wrapped-password");
  });

  it.each([
    ["semicolon", "pa;ssword"],
    ["comma", "pa,ssword"],
    ["balanced parentheses", "pa(ss)word"],
  ])("redacts credentials containing valid %s punctuation", (_label, password) => {
    const result = redact(`proxy https://userinfo-user:${password}@proxy.example/path failed`);

    expect(result).toContain("https://****:****@proxy.example/path");
    expect(result).not.toContain("userinfo-user");
    expect(result).not.toContain(password);
  });

  it("fully removes generic-scheme userinfo and sensitive query values", () => {
    const result = redactUrl(
      "FtP://ftp-user:ftp-password@files.example/path?token=secret-value#fragment",
    );

    expect(result).toBe("ftp://files.example/path?token=%3CREDACTED%3E");
  });
});

describe("redactForLog", () => {
  it("redacts pass aliases in structured keys and canonical text assignments", () => {
    const payload = "opaqueCredentialPayloadZ1234567890";

    expect(
      redactForLog({
        pass: payload,
        passwd: payload,
        customPass: payload,
        customPasswd: payload,
        DBPass: payload,
        db_pass: payload,
        "db-pass": payload,
        replyToken: payload,
      }),
    ).toEqual({
      pass: "<REDACTED>",
      passwd: "<REDACTED>",
      customPass: "<REDACTED>",
      customPasswd: "<REDACTED>",
      DBPass: "<REDACTED>",
      db_pass: "<REDACTED>",
      "db-pass": "<REDACTED>",
      replyToken: "<REDACTED>",
    });
    for (const [assignment, expected] of [
      [`CUSTOM_PASS=${payload}`, "CUSTOM_PASS=<REDACTED>"],
      [`CUSTOM_PASSWD=${payload}`, "CUSTOM_PASSWD=<REDACTED>"],
      [`CUSTOM_PASS ${payload}`, "CUSTOM_PASS <REDACTED>"],
      ["CUSTOM_PASS=!OpaquePassword123", "CUSTOM_PASS=<REDACTED>"],
      ["CUSTOM_PASS=abcdefghij!tail-secret", "CUSTOM_PASS=<REDACTED>"],
      ["CUSTOM_PASS=,OpaquePassword123", "CUSTOM_PASS=<REDACTED>"],
      ["CUSTOM_PASS=OpaquePassword123,", "CUSTOM_PASS=<REDACTED>"],
      [`PASS: ${payload}`, "PASS: <REDACTED>"],
      [`PASS = ${payload}`, "PASS = <REDACTED>"],
      [`{"PASS":"${payload}"}`, '{"PASS":"<REDACTED>"}'],
      [`api-key=${payload}`, "api-key=<REDACTED>"],
      [`X-Api-Key=${payload}`, "X-Api-Key=<REDACTED>"],
      [`clientSecret=${payload}`, "clientSecret=<REDACTED>"],
      [`replyToken=${payload}`, "replyToken=<REDACTED>"],
      [`{"replyToken":"${payload}"}`, '{"replyToken":"<REDACTED>"}'],
      [`githubToken=${payload}`, "githubToken=<REDACTED>"],
      [`webhookSecret=${payload}`, "webhookSecret=<REDACTED>"],
      [`databaseCredential=${payload}`, "databaseCredential=<REDACTED>"],
      [`customPass=${payload}`, "customPass=<REDACTED>"],
      [`DBPass=${payload}`, "DBPass=<REDACTED>"],
    ]) {
      expect(redactSensitiveText(assignment)).toBe(expected);
      expect(redactFull(assignment)).toBe(expected);
      expect(redactForLog(assignment)).toBe(expected);
    }
  });

  it("preserves benign structured keys and assignments containing pass", () => {
    const benign = {
      compass: "north",
      bypass: false,
      passengerCount: 2,
      passed: true,
      passRate: 0.9,
      passCount: 4,
      passThrough: "enabled",
      correlationMarker: "reply-correlation-marker-123",
    };

    expect(redactForLog(benign)).toEqual(benign);
    for (const text of [
      "COMPASS=opaqueNonSecretPayload123 BYPASS=allowedValue123",
      "TOPSECRET=opaqueNonSecretPayload123 SUBTOKEN=opaqueNonSecretPayload123",
      "publicKey=opaqueVerificationMaterial123 customKey=opaqueNonSecretPayload123",
      "public-key=opaqueVerificationMaterial123 custom-key=opaqueNonSecretPayload123",
      "passRate=opaqueNonSecretPayload123",
      '{"key":"agent:main:main"}',
      '{"correlationMarker":"reply-correlation-marker-123"}',
    ]) {
      expect(redactSensitiveText(text), text).toBe(text);
      expect(redactFull(text), text).toBe(text);
      expect(redactForLog(text), text).toBe(text);
    }
  });

  it("redacts sensitive object keys recursively while preserving safe fields", () => {
    const result = redactForLog({
      provider: "openai",
      apiKey: "sk-" + "a".repeat(24),
      replyToken: "opaqueCredentialPayloadZ1234567890",
      nested: {
        model: "gpt-4o",
        refreshToken: "refresh-token-value",
      },
      items: [{ name: "safe" }, { credentialEnv: "NVIDIA_INFERENCE_API_KEY" }],
    });

    expect(result).toEqual({
      provider: "openai",
      apiKey: "<REDACTED>",
      replyToken: "<REDACTED>",
      nested: {
        model: "gpt-4o",
        refreshToken: "<REDACTED>",
      },
      items: [{ name: "safe" }, { credentialEnv: "<REDACTED>" }],
    });
  });

  it("redacts known secret patterns inside otherwise safe strings", () => {
    const result = redactForLog({
      message: "upstream returned Authorization: Bearer abcdefghijklmnop",
      url: "https://example.test/path?access_token=abcdefghijklmnop",
    });

    expect(result).toEqual({
      message: "upstream returned Authorization: Bearer <REDACTED>",
      url: "https://example.test/path?access_token=<REDACTED>",
    });
  });

  it("redacts generated private-key blocks inside otherwise safe strings", () => {
    const privateKey = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "unknown-generated-private-key-material",
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join("\\n");

    const result = redactForLog({ snapshot: JSON.stringify({ privateKey }) });

    expect(result).toEqual({ snapshot: '{"privateKey":"<REDACTED>"}' });
  });

  it("does not recurse forever on circular objects", () => {
    const input: Record<string, unknown> = { name: "root" };
    input.self = input;

    expect(redactForLog(input)).toEqual({
      name: "root",
      self: "[Circular]",
    });
  });
});
