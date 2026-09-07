// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import type { ConfigValue } from "./credential-filter-boundary.cjs";

import {
  CONTEXT_PATTERNS,
  CREDENTIAL_PLACEHOLDER,
  isConfigObject,
  isConfigValue,
  isCredentialField,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  redactCredentialText,
  sanitizeEnvFileContent,
  SECRET_BLOCK_PATTERNS,
  SECRET_PATTERNS,
  stripCredentials,
  STRUCTURED_TOKEN_PATTERNS,
  TOKEN_PREFIX_PATTERNS,
  URL_TOKEN_PATTERN_SOURCE,
  valueLooksLikeSecret,
} from "./credential-filter-boundary.cjs";

function asConfigValue(value: ConfigValue): ConfigValue {
  return value;
}

describe("shared credential filter", () => {
  it.each([
    ["ordinary", "https://example.test/path"],
    ["single-quote-split userinfo", "https://operator:secret'fragment@example.test/path"],
    ["double-quote-split userinfo", 'https://operator:secret"fragment@example.test/path'],
    ["credential query", "https://example.test/path?apiKey=opaque"],
    ["credential fragment", "https://example.test/path#token=opaque"],
    ["delimiter suffix", "https://example.test/path)."],
    ["malformed authority", "https://operator:secret@[not-an-ip/path"],
  ])("matches the complete %s URL token", (_case, value) => {
    expect(value.match(new RegExp(URL_TOKEN_PATTERN_SOURCE, "giu"))).toEqual([value]);
  });

  it("preserves the ConfigValue return contract (#8291)", () => {
    const value = asConfigValue({ token: "opaque-secret-value" });
    const result = stripCredentials(value);

    expect(result).toEqual({ token: CREDENTIAL_PLACEHOLDER });
    expect(stripCredentials(null as ConfigValue)).toBeNull();
    expectTypeOf(result).toEqualTypeOf<ConfigValue>();
  });

  it("accepts only recursively representable configuration values (#8291)", () => {
    const nullPrototype = Object.assign(Object.create(null), { enabled: true });

    expect(isConfigObject({})).toBe(true);
    expect(isConfigObject(nullPrototype)).toBe(true);
    expect(isConfigObject(null)).toBe(false);
    expect(isConfigObject([])).toBe(false);
    expect(isConfigValue(undefined)).toBe(true);
    expect(isConfigValue(["model", 1, false, null, nullPrototype])).toBe(true);
    expect(isConfigValue(new Date())).toBe(false);
    expect(isConfigValue({ nested: new Date() })).toBe(false);
    expect(isConfigValue(["model", new Date()])).toBe(false);
  });

  it.each([
    "botToken",
    "bot_token",
    "appToken",
    "access_token",
    "personal_access_token",
    "refresh-token",
    "client_secret",
    "auth_token",
    "oauth_token",
    "apikey",
    "Token",
    "GITHUB_TOKEN",
    "Authorization",
    "X-API-Key",
    "DB_PASS",
  ])("classifies credential field %s as sensitive (#8291)", (field) => {
    expect(isCredentialField(field), field).toBe(true);
  });

  it.each(["publicKey", "public.key", "GITHUB_PUBLIC_KEY", "NODE_ENV", "model"])(
    "classifies non-credential field %s as non-sensitive (#8291)",
    (field) => {
      expect(isCredentialField(field), field).toBe(false);
    },
  );

  it.each([
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Bearer opaque-migration-secret",
    "GITHUB_TOKEN=opaque-secret-value-123",
    ["-----BEGIN", "PRIVATE KEY-----\nopaque\n-----END PRIVATE KEY-----"].join(" "),
  ])("recognizes raw secret vector %# (#8291)", (value) => {
    expect(valueLooksLikeSecret(value), value).toBe(true);
  });

  it.each([
    "unused",
    "Bearer unused",
    "openshell:resolve:env:GITHUB_TOKEN",
    "Bearer openshell:resolve:env:REMOTE_MCP_TOKEN",
    "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_TOKEN",
  ])("preserves credential reference %s (#8291)", (value) => {
    expect(isSafeCredentialPlaceholder(value), value).toBe(true);
  });

  it("preserves a value that has no secret shape (#8291)", () => {
    expect(valueLooksLikeSecret("keep-me")).toBe(false);
    expect(stripCredentials({ model: "unused" })).toEqual({ model: "unused" });
  });

  it("strips URL userinfo from non-credential fields", () => {
    expect(stripCredentials({ host: "https://operator:opaque-value@api.example" })).toEqual({
      host: CREDENTIAL_PLACEHOLDER,
    });
  });

  it("fully redacts credential-bearing URLs and non-uppercase assignments in diagnostics", () => {
    const urlCredential = "opaque-url-credential";
    const assignmentCredential = "opaque-lowercase-credential";
    const redacted = redactCredentialText(
      `policy write failed at https://operator:${urlCredential}@api.example apiKey=${assignmentCredential}`,
    );

    expect(redacted).toContain("policy write failed at");
    expect(redacted).toContain("https://api.example/");
    expect(redacted).toContain("apiKey=<REDACTED>");
    expect(redacted).not.toContain(urlCredential);
    expect(redacted).not.toContain(assignmentCredential);
    expect(redacted).toContain("<REDACTED>");

    const queryAndHash = redactCredentialText(
      "failed at https://api.example/path?apiKey=opaque-query-credential#token=opaque-hash-credential",
    );
    expect(queryAndHash).toContain("apiKey=<REDACTED>");
    expect(queryAndHash).not.toContain("opaque-query-credential");
    expect(queryAndHash).not.toContain("opaque-hash-credential");
    expect(redactCredentialText("failed at https://%")).toBe("failed at <REDACTED>");
  });

  it.each(["'", '"'])("fully redacts URL userinfo split by %s", (quote) => {
    const credential = "opaque-url-credential";

    expect(
      redactCredentialText(
        `failed at https://operator:${credential}${quote}fragment@example.test/path`,
      ),
    ).toBe("failed at https://example.test/path");
  });

  it.each([
    ["token prefix", TOKEN_PREFIX_PATTERNS],
    ["structured token", STRUCTURED_TOKEN_PATTERNS],
    ["context", CONTEXT_PATTERNS],
    ["secret block", SECRET_BLOCK_PATTERNS],
    ["secret", SECRET_PATTERNS],
  ] as const)("freezes the %s pattern collection (#8291)", (_name, patterns) => {
    expect(Object.isFrozen(patterns)).toBe(true);
    expect(() => (patterns as RegExp[]).push(/caller-added-secret/g)).toThrow(TypeError);
  });

  it("tolerates caller lastIndex state (#8291)", () => {
    TOKEN_PREFIX_PATTERNS[0].lastIndex = Number.MAX_SAFE_INTEGER;
    expect(valueLooksLikeSecret("nvapi-abcdefghijklmnop")).toBe(true);
  });

  it("strips object, array, header, and environment credentials (#8291)", () => {
    const fixture = {
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: "xoxb-raw-slack-token",
              appToken: "xapp-raw-app-token",
            },
          },
        },
      },
      mcp: {
        headers: { Authorization: "Bearer opaque-migration-secret" },
        env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", NODE_ENV: "test" },
        args: ["--api-key", "opaque-secret-value", "--verbose"],
      },
      oauth: {
        access_token: "opaque-access-value",
        refresh_token: "opaque-refresh-value",
        client_secret: "opaque-client-value",
      },
      apiKey: "openshell:resolve:env:NVIDIA_API_KEY",
      publicKey: "verify-me",
      model: "keep-me",
    };

    expect(stripCredentials(fixture)).toEqual({
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: CREDENTIAL_PLACEHOLDER,
              appToken: CREDENTIAL_PLACEHOLDER,
            },
          },
        },
      },
      mcp: {
        headers: { Authorization: CREDENTIAL_PLACEHOLDER },
        env: { GITHUB_TOKEN: CREDENTIAL_PLACEHOLDER, NODE_ENV: "test" },
        args: ["--api-key", CREDENTIAL_PLACEHOLDER, "--verbose"],
      },
      oauth: {
        access_token: CREDENTIAL_PLACEHOLDER,
        refresh_token: CREDENTIAL_PLACEHOLDER,
        client_secret: CREDENTIAL_PLACEHOLDER,
      },
      apiKey: "openshell:resolve:env:NVIDIA_API_KEY",
      publicKey: "verify-me",
      model: "keep-me",
    });

    expect(
      sanitizeEnvFileContent(
        [
          "CUSTOM=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          "ENDPOINT=Bearer opaque-migration-secret",
          "SAFE=openshell:resolve:env:SAFE",
          "NODE_ENV=production",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        `CUSTOM=${CREDENTIAL_PLACEHOLDER}`,
        `ENDPOINT=${CREDENTIAL_PLACEHOLDER}`,
        "SAFE=openshell:resolve:env:SAFE",
        "NODE_ENV=production",
        "",
      ].join("\n"),
    );
  });

  it("strips separated and inline CLI credentials without consuming later flags (#8291)", () => {
    expect(
      stripCredentials([
        "--api-key",
        "-opaque-secret-value",
        "--token=opaque-inline-value",
        "--api-key=openshell:resolve:env:NVIDIA_API_KEY",
        "--verbose",
      ]),
    ).toEqual([
      "--api-key",
      CREDENTIAL_PLACEHOLDER,
      `--token=${CREDENTIAL_PLACEHOLDER}`,
      "--api-key=openshell:resolve:env:NVIDIA_API_KEY",
      "--verbose",
    ]);
  });

  it("classifies only credential-sensitive basenames (#8291)", () => {
    expect(isSensitiveFile("auth.json")).toBe(true);
    expect(isSensitiveFile("AUTH-PROFILES.JSON")).toBe(true);
    expect(isSensitiveFile("config.json")).toBe(false);
  });
});
