// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_PLACEHOLDER,
  isCredentialField,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  sanitizeEnvFileContent,
  stripCredentials,
  valueLooksLikeSecret,
} from "./credential-filter.js";

describe("plugin credential-filter", () => {
  it("treats Slack botToken, Authorization, and GITHUB_TOKEN as credential fields", () => {
    expect(isCredentialField("botToken")).toBe(true);
    expect(isCredentialField("appToken")).toBe(true);
    expect(isCredentialField("Authorization")).toBe(true);
    expect(isCredentialField("GITHUB_TOKEN")).toBe(true);
    expect(isCredentialField("DB_PASS")).toBe(true);
    expect(isCredentialField("publicKey")).toBe(false);
    expect(isCredentialField("NODE_ENV")).toBe(false);
  });

  it("strips channel tokens, headers, env secrets, and CLI flag args", () => {
    const result = stripCredentials({
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
        headers: { Authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz" },
        env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", NODE_ENV: "test" },
        args: ["--api-key", "opaque-secret-value", "--verbose"],
      },
      customHeader: "Bearer opaque-migration-secret",
      model: "keep-me",
      publicKey: "verify-me",
      apiKey: "openshell:resolve:env:NVIDIA_API_KEY",
    }) as Record<string, unknown>;

    const channels = result.channels as {
      slack: { accounts: { default: { botToken: string; appToken: string } } };
    };
    expect(channels.slack.accounts.default.botToken).toBe(CREDENTIAL_PLACEHOLDER);
    expect(channels.slack.accounts.default.appToken).toBe(CREDENTIAL_PLACEHOLDER);

    const mcp = result.mcp as {
      headers: { Authorization: string };
      env: { GITHUB_TOKEN: string; NODE_ENV: string };
      args: string[];
    };
    expect(mcp.headers.Authorization).toBe(CREDENTIAL_PLACEHOLDER);
    expect(mcp.env.GITHUB_TOKEN).toBe(CREDENTIAL_PLACEHOLDER);
    expect(mcp.env.NODE_ENV).toBe("test");
    expect(mcp.args).toEqual(["--api-key", CREDENTIAL_PLACEHOLDER, "--verbose"]);
    expect(result.customHeader).toBe(CREDENTIAL_PLACEHOLDER);
    expect(result.model).toBe("keep-me");
    expect(result.publicKey).toBe("verify-me");
    expect(result.apiKey).toBe("openshell:resolve:env:NVIDIA_API_KEY");
  });

  it("preserves safe placeholders and detects secret-shaped values", () => {
    expect(isSafeCredentialPlaceholder("unused")).toBe(true);
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:TOKEN")).toBe(true);
    expect(valueLooksLikeSecret("sk-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(valueLooksLikeSecret("glpat-abcdefghijklmnopqrst")).toBe(true);
    expect(valueLooksLikeSecret("nvcf-abcdefghij")).toBe(true);
    expect(valueLooksLikeSecret("not-a-secret")).toBe(false);
  });

  it("preserves null and undefined under credential field names", () => {
    const result = stripCredentials({ apiKey: null, token: undefined, model: "keep" }) as Record<
      string,
      unknown
    >;
    expect(result.apiKey).toBeNull();
    expect(result.token).toBeUndefined();
    expect(result.model).toBe("keep");
  });

  it("strips secret-shaped env values stored under benign keys", () => {
    const result = sanitizeEnvFileContent(
      [
        "MODEL=keep-me",
        "CUSTOM=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "ENDPOINT=Bearer opaque-migration-secret",
        "SAFE=openshell:resolve:env:SAFE",
        "",
      ].join("\n"),
    );

    expect(result).toContain("MODEL=keep-me");
    expect(result).toContain("CUSTOM=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("ENDPOINT=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("SAFE=openshell:resolve:env:SAFE");
  });

  it("excludes auth state basenames from migration copies", () => {
    expect(isSensitiveFile("auth-profiles.json")).toBe(true);
    expect(isSensitiveFile("auth.json")).toBe(true);
    expect(isSensitiveFile("chatgpt-auth.json")).toBe(true);
    expect(isSensitiveFile("openclaw.json")).toBe(false);
  });
});
