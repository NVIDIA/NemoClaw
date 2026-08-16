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
  sanitizeEnvFileContent,
  SECRET_BLOCK_PATTERNS,
  SECRET_PATTERNS,
  stripCredentials,
  STRUCTURED_TOKEN_PATTERNS,
  TOKEN_PREFIX_PATTERNS,
  valueLooksLikeSecret,
} from "./credential-filter-boundary.cjs";

function asConfigValue(value: ConfigValue): ConfigValue {
  return value;
}

describe("shared credential filter", () => {
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

  it("classifies credential names without treating public keys as secrets (#8291)", () => {
    for (const field of [
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
    ]) {
      expect(isCredentialField(field), field).toBe(true);
    }
    for (const field of ["publicKey", "public.key", "GITHUB_PUBLIC_KEY", "NODE_ENV", "model"]) {
      expect(isCredentialField(field), field).toBe(false);
    }
  });

  it("recognizes raw secrets while preserving credential references (#8291)", () => {
    for (const value of [
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Bearer opaque-migration-secret",
      "GITHUB_TOKEN=opaque-secret-value-123",
      ["-----BEGIN", "PRIVATE KEY-----\nopaque\n-----END PRIVATE KEY-----"].join(" "),
    ]) {
      expect(valueLooksLikeSecret(value), value).toBe(true);
    }
    for (const value of [
      "unused",
      "Bearer unused",
      "openshell:resolve:env:GITHUB_TOKEN",
      "Bearer openshell:resolve:env:REMOTE_MCP_TOKEN",
      "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_TOKEN",
    ]) {
      expect(isSafeCredentialPlaceholder(value), value).toBe(true);
    }
    expect(valueLooksLikeSecret("keep-me")).toBe(false);
  });

  it("freezes exported pattern collections and tolerates caller lastIndex state (#8291)", () => {
    for (const patterns of [
      TOKEN_PREFIX_PATTERNS,
      STRUCTURED_TOKEN_PATTERNS,
      CONTEXT_PATTERNS,
      SECRET_BLOCK_PATTERNS,
      SECRET_PATTERNS,
    ]) {
      expect(Object.isFrozen(patterns)).toBe(true);
      expect(() => (patterns as RegExp[]).push(/caller-added-secret/g)).toThrow(TypeError);
    }

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
