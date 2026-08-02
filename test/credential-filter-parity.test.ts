// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isCredentialField as isPluginCredentialField,
  isSafeCredentialPlaceholder as isPluginSafePlaceholder,
  valueLooksLikeSecret as pluginValueLooksLikeSecret,
  sanitizeEnvFileContent as sanitizePluginEnvFileContent,
  stripCredentials as stripPluginCredentials,
} from "../nemoclaw/src/security/credential-filter.js";
import {
  isCredentialField as isSharedCredentialField,
  isSafeCredentialPlaceholder as isSharedSafePlaceholder,
  sanitizeEnvFileContent as sanitizeSharedEnvFileContent,
  valueLooksLikeSecret as sharedValueLooksLikeSecret,
  stripCredentials as stripSharedCredentials,
} from "../src/lib/security/credential-filter.js";

describe("credential filter parity", () => {
  it("keeps plugin and shared classification rules aligned", () => {
    const fields = [
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
      "publicKey",
      "NODE_ENV",
      "model",
    ];
    const values = [
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Bearer opaque-migration-secret",
      "openshell:resolve:env:GITHUB_TOKEN",
      "Bearer openshell:resolve:env:REMOTE_MCP_TOKEN",
      "keep-me",
    ];

    for (const field of fields) {
      expect(isPluginCredentialField(field), field).toBe(isSharedCredentialField(field));
    }
    for (const value of values) {
      expect(pluginValueLooksLikeSecret(value), value).toBe(sharedValueLooksLikeSecret(value));
      expect(isPluginSafePlaceholder(value), value).toBe(isSharedSafePlaceholder(value));
    }
  });

  it("produces identical object and env-file sanitization", () => {
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
      model: "keep-me",
    };
    const envFixture = [
      "CUSTOM=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "ENDPOINT=Bearer opaque-migration-secret",
      "NODE_ENV=production",
      "",
    ].join("\n");

    expect(stripPluginCredentials(fixture)).toEqual(stripSharedCredentials(fixture));
    expect(sanitizePluginEnvFileContent(envFixture)).toBe(sanitizeSharedEnvFileContent(envFixture));
  });
});
