// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { redactForLog, redactFull, redactLogSequence, redactSensitiveText } from "./redact.js";

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
      tokenizer: "cl100k_base",
      maxTokens: 1024,
      secretary: "safe role",
      credentialing: "complete",
      passwordless: true,
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

  it("uses canonical credential fields for opaque structured values without false positives", () => {
    expect(
      redactForLog({
        auth: "opaque-auth-secret",
        API_SERVER_KEY: "opaque-server-key",
        NEMOCLAW_PROVIDER_KEY: "opaque-provider-key",
        privateKey: "opaque-private-key",
        sessionKey: "opaque-session-key",
        setCookie: "session=opaque-set-cookie-secret",
        "API Key": "opaque-api-secret",
        APIKey: "opaque-api-secret-with-acronym",
        apikey: "opaque-run-together-api-secret",
        APIKEY: "opaque-uppercase-api-secret",
        headers: {
          "Proxy-Authorization": "Basic opaque-basic-secret",
          Cookie: "session=opaque-cookie-secret",
        },
        secretValue: "opaque-secret-value",
        tokenValue: "opaque-token-value",
        passwordValue: "opaque-password-value",
        credentials: "opaque-credentials-value",
        publicKey: "safe public key",
        PUBLIC_KEY: "safe uppercase public key",
        author: "safe author",
        oauth: "safe auth method",
      }),
    ).toEqual({
      auth: "<REDACTED>",
      API_SERVER_KEY: "<REDACTED>",
      NEMOCLAW_PROVIDER_KEY: "<REDACTED>",
      privateKey: "<REDACTED>",
      sessionKey: "<REDACTED>",
      setCookie: "<REDACTED>",
      "API Key": "<REDACTED>",
      APIKey: "<REDACTED>",
      apikey: "<REDACTED>",
      APIKEY: "<REDACTED>",
      headers: {
        "Proxy-Authorization": "<REDACTED>",
        Cookie: "<REDACTED>",
      },
      secretValue: "<REDACTED>",
      tokenValue: "<REDACTED>",
      passwordValue: "<REDACTED>",
      credentials: "<REDACTED>",
      publicKey: "safe public key",
      PUBLIC_KEY: "safe uppercase public key",
      author: "safe author",
      oauth: "safe auth method",
    });
  });

  it("redacts opaque CLI values by sequence and inline flag context", () => {
    expect(
      redactForLog({
        argv: [
          "--password",
          "opaque-password",
          "--api-key",
          "opaque-api-key",
          "--private-key=opaque-inline-private-key",
          "--session-key",
          "opaque-session-key",
          "--password",
          "-opaque-leading-dash",
          "--api-key",
          "--opaque-leading-double-dash",
          "--public-key",
          "safe-public-key",
          "--author",
          "safe-author",
          "--password",
          "--verbose",
          "safe-tail",
        ],
      }),
    ).toEqual({
      argv: [
        "--password",
        "<REDACTED>",
        "--api-key",
        "<REDACTED>",
        "--private-key=<REDACTED>",
        "--session-key",
        "<REDACTED>",
        "--password",
        "<REDACTED>",
        "--api-key",
        "<REDACTED>",
        "--public-key",
        "safe-public-key",
        "--author",
        "safe-author",
        "--password",
        "<REDACTED>",
        "safe-tail",
      ],
    });

    expect(
      redactLogSequence([
        "OPENAI_API_KEY",
        "opaque-env-value",
        "NEMOCLAW_PROVIDER_KEY",
        "-opaque-leading-dash-value",
        "token",
        "opaque-token-label",
        "API Key:",
        "opaque-api-key-label",
        "proxyAuth",
        "opaque-proxy-auth-label",
        "proxyAuth:",
        "opaque-proxy-auth-colon-label",
        "public key",
        "safe-public-key",
        "author",
        "safe-author",
        "Failed to refresh token, retrying",
        { attempt: 3 },
        "Token refresh failed",
        { attempt: 4 },
      ]),
    ).toEqual([
      "OPENAI_API_KEY",
      "<REDACTED>",
      "NEMOCLAW_PROVIDER_KEY",
      "<REDACTED>",
      "token",
      "<REDACTED>",
      "API Key:",
      "<REDACTED>",
      "proxyAuth",
      "<REDACTED>",
      "proxyAuth:",
      "<REDACTED>",
      "public key",
      "safe-public-key",
      "author",
      "safe-author",
      "Failed to refresh token, retrying",
      { attempt: 3 },
      "Token refresh failed",
      { attempt: 4 },
    ]);
  });

  it("redacts Basic, Digest, proxy-auth, and cookie text without matching safe labels", () => {
    const text = [
      "Authorization: Basic opaque-basic-value",
      "Proxy-Authorization: Digest username=opaque-user, response=opaque-response",
      "Authorization: Basic-Plus opaque-basic-plus",
      "Authorization: Bearer+DPoP opaque-bearer-plus",
      "Proxy-Authorization: Digest-v2 opaque-digest-v2",
      "Authorization=Basic opaque-equals-auth",
      "Proxy-Authorization=Digest opaque-equals-proxy",
      "Cookie=session=opaque-equals-cookie",
      "Set-Cookie=session=opaque-equals-set-cookie",
      "Cookie: session=opaque-cookie-value",
      "Set-Cookie: session=opaque-set-cookie-value; HttpOnly",
      'headers={"Authorization":"Basic opaque-json-value"}',
      "author: safe-author",
    ].join("\n");

    const result = redactFull(text);
    for (const secret of [
      "opaque-basic-value",
      "opaque-user",
      "opaque-response",
      "opaque-basic-plus",
      "opaque-bearer-plus",
      "opaque-digest-v2",
      "opaque-equals-auth",
      "opaque-equals-proxy",
      "opaque-equals-cookie",
      "opaque-equals-set-cookie",
      "opaque-cookie-value",
      "opaque-set-cookie-value",
      "opaque-json-value",
    ]) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain("author: safe-author");
  });

  it("preserves same-line diagnostics after Basic and Bearer credentials", () => {
    expect(redactFull("Authorization: Bearer opaque-bearer-value request failed")).toBe(
      "Authorization: Bearer <REDACTED> request failed",
    );
  });

  it("redacts folded credential headers without consuming the next diagnostic line", () => {
    for (const header of ["Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie"]) {
      const result = redactFull(`${header}:\r\n\topaque-folded-value\r\nnext diagnostic`);
      expect(result).toBe(`${header}: <REDACTED>\r\nnext diagnostic`);
    }
    expect(redactFull("Authorization:\ropaque-bare-cr\rnext diagnostic")).toBe(
      "Authorization: <REDACTED>\rnext diagnostic",
    );
  });

  it("fails closed for malformed quoted credential fields", () => {
    for (const input of [
      '{"Authorization":"Basic opaque-unterminated',
      '{"Cookie":"session=opaque-unterminated',
      '{"Authorization": Basic opaque-unquoted}',
    ]) {
      expect(redactFull(input)).not.toContain("opaque-");
    }
    expect(redactFull('{"Authorization":"Basic opaque-complete","status":"kept"}')).toBe(
      '{"Authorization":"Basic <REDACTED>","status":"kept"}',
    );
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
