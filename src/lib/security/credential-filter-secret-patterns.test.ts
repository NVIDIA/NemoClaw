// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isCredentialField, stripCredentials, valueLooksLikeSecret } from "./credential-filter.js";

describe("isCredentialField", () => {
  it("matches explicit field names", () => {
    expect(isCredentialField("apiKey")).toBe(true);
    expect(isCredentialField("api_key")).toBe(true);
    expect(isCredentialField("token")).toBe(true);
    expect(isCredentialField("secret")).toBe(true);
    expect(isCredentialField("password")).toBe(true);
    expect(isCredentialField("resolvedKey")).toBe(true);
  });

  it("matches pattern-based names", () => {
    expect(isCredentialField("accessToken")).toBe(true);
    expect(isCredentialField("refreshToken")).toBe(true);
    expect(isCredentialField("clientSecret")).toBe(true);
    expect(isCredentialField("bearerToken")).toBe(true);
    expect(isCredentialField("privateKey")).toBe(true);
    expect(isCredentialField("sessionToken")).toBe(true);
    expect(isCredentialField("sessionKey")).toBe(true);
    // OpenClaw channel token fields (#5027).
    expect(isCredentialField("botToken")).toBe(true);
    expect(isCredentialField("appToken")).toBe(true);
  });

  it("matches terminal pass aliases without treating pass substrings as credentials", () => {
    for (const field of [
      "pass",
      "passwd",
      "customPass",
      "customPasswd",
      "DBPass",
      "db_pass",
      "db_passwd",
      "db-pass",
      "db-passwd",
    ]) {
      expect(isCredentialField(field), field).toBe(true);
    }
    for (const field of [
      "COMPASS",
      "BYPASS",
      "passengerCount",
      "passed",
      "passRate",
      "passCount",
      "passThrough",
    ]) {
      expect(isCredentialField(field), field).toBe(false);
    }
  });

  it("matches env-variable-style secret names (#5027)", () => {
    expect(isCredentialField("GITHUB_TOKEN")).toBe(true);
    expect(isCredentialField("BRAVE_API_KEY")).toBe(true);
    expect(isCredentialField("OPENAI_API_KEY")).toBe(true);
    expect(isCredentialField("API_SERVER_KEY")).toBe(true);
    expect(isCredentialField("NEMOCLAW_PROVIDER_KEY")).toBe(true);
    expect(isCredentialField("DB_PASSWORD")).toBe(true);
    expect(isCredentialField("DB_PASSWD")).toBe(true);
    expect(isCredentialField("DB_PASS")).toBe(true);
    expect(isCredentialField("SLACK_APP_TOKEN")).toBe(true);
    // Bare uppercase secret words must also be scrubbed.
    expect(isCredentialField("TOKEN")).toBe(true);
    expect(isCredentialField("PASSWORD")).toBe(true);
    expect(isCredentialField("PASSWD")).toBe(true);
    expect(isCredentialField("PASS")).toBe(true);
    expect(isCredentialField("SECRET")).toBe(true);
    expect(isCredentialField("CREDENTIALS")).toBe(true);
  });

  it("matches well-known HTTP auth header names (#5027)", () => {
    expect(isCredentialField("Authorization")).toBe(true);
    expect(isCredentialField("authorization")).toBe(true);
    expect(isCredentialField("Proxy-Authorization")).toBe(true);
    expect(isCredentialField("X-API-Key")).toBe(true);
    expect(isCredentialField("X-API-Token")).toBe(true);
    expect(isCredentialField("x-auth-token")).toBe(true);
    expect(isCredentialField("Private-Token")).toBe(true);
    expect(isCredentialField("X-Custom-Auth")).toBe(true);
    expect(isCredentialField("Cookie")).toBe(true);
  });

  it("does not match safe field names", () => {
    expect(isCredentialField("name")).toBe(false);
    expect(isCredentialField("model")).toBe(false);
    expect(isCredentialField("provider")).toBe(false);
    expect(isCredentialField("endpoint")).toBe(false);
    expect(isCredentialField("version")).toBe(false);
    // Benign env/setting names must not be scrubbed.
    expect(isCredentialField("NODE_ENV")).toBe(false);
    expect(isCredentialField("LOG_LEVEL")).toBe(false);
    expect(isCredentialField("PATH")).toBe(false);
    expect(isCredentialField("tokenizer")).toBe(false);
    expect(isCredentialField("maxTokens")).toBe(false);
    expect(isCredentialField("X-Request-Id")).toBe(false);
    expect(isCredentialField("author")).toBe(false);
  });

  it("does not strip public keys (verification material, not secrets)", () => {
    expect(isCredentialField("publicKey")).toBe(false);
    expect(isCredentialField("PUBLIC_KEY")).toBe(false);
    expect(isCredentialField("public-key")).toBe(false);
    expect(isCredentialField("X-Public-Key")).toBe(false);
    expect(isCredentialField("GITHUB_PUBLIC_KEY")).toBe(false);
    // But private keys and other secret fields still match.
    expect(isCredentialField("privateKey")).toBe(true);
    expect(isCredentialField("PRIVATE_KEY")).toBe(true);
    expect(isCredentialField("apiKey")).toBe(true);
  });
});

describe("valueLooksLikeSecret", () => {
  it("matches recognizable secret formats", () => {
    expect(valueLooksLikeSecret("ghp_0123456789abcdef")).toBe(true);
    expect(valueLooksLikeSecret("sk-proj-0123456789abcdefghij")).toBe(true);
    expect(valueLooksLikeSecret("xoxb-123456789-abcdefghij")).toBe(true);
    expect(valueLooksLikeSecret("Bearer abcdef0123456789")).toBe(true);
  });

  it("does not match benign values", () => {
    expect(valueLooksLikeSecret("npx")).toBe(false);
    expect(valueLooksLikeSecret("https://integrate.api.nvidia.com/v1")).toBe(false);
    expect(valueLooksLikeSecret("moonshotai/kimi-k2")).toBe(false);
    expect(valueLooksLikeSecret("production")).toBe(false);
  });
});

describe("stripCredentials", () => {
  it("strips terminal pass aliases while preserving benign pass substrings", () => {
    const payload = "opaqueCredentialPayloadZ1234567890";
    const result = stripCredentials({
      customPass: payload,
      customPasswd: payload,
      DBPass: payload,
      db_pass: payload,
      db_passwd: payload,
      "db-pass": payload,
      COMPASS: "north",
      BYPASS: "allowed",
      passRate: 0.9,
      passCount: 4,
      passThrough: true,
    });

    for (const field of [
      "customPass",
      "customPasswd",
      "DBPass",
      "db_pass",
      "db_passwd",
      "db-pass",
    ]) {
      expect((result as Record<string, unknown>)[field], field).toBe("[STRIPPED_BY_MIGRATION]");
    }
    expect(result).toMatchObject({
      COMPASS: "north",
      BYPASS: "allowed",
      passRate: 0.9,
      passCount: 4,
      passThrough: true,
    });
  });

  it("strips raw channel tokens and MCP env secrets from openclaw.json (#5027)", () => {
    const input = {
      channels: {
        slack: {
          accounts: { default: { botToken: "xoxb-123-realsecret", appToken: "xapp-1-realsecret" } },
        },
      },
      mcpServers: {
        github: {
          command: "npx",
          env: {
            GITHUB_TOKEN: "ghp_realsecret",
            TOKEN: "raw",
            PASSWORD: "pw",
            NODE_ENV: "production",
          },
        },
      },
    };
    const result = stripCredentials(input);
    expect(result.channels.slack.accounts.default.botToken).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.channels.slack.accounts.default.appToken).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.mcpServers.github.env.GITHUB_TOKEN).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.mcpServers.github.env.TOKEN).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.mcpServers.github.env.PASSWORD).toBe("[STRIPPED_BY_MIGRATION]");
    // Non-secret env vars and command survive.
    expect(result.mcpServers.github.env.NODE_ENV).toBe("production");
    expect(result.mcpServers.github.command).toBe("npx");
  });

  it("strips MCP HTTP auth headers by name and value backstop (#5027)", () => {
    const input = {
      mcpServers: {
        remote: {
          url: "https://mcp.example.com",
          headers: {
            Authorization: "Bearer ghp_0123456789abcdef",
            "X-API-Key": "sk-0123456789abcdefghij", // gitleaks:allow
            // Opaque value (no recognizable prefix) caught by header name.
            "X-API-Token": "plain-opaque-value-12345",
            // Opaque value under a custom -auth header, caught by header name.
            "X-Custom-Auth": "plain-opaque-value-67890",
            // Bearer resolve reference must survive (only a reference, no secret).
            "X-Auth-Token": "Bearer openshell:resolve:env:REMOTE_MCP_TOKEN",
            "X-Request-Id": "req-12345",
          },
        },
      },
    };
    const result = stripCredentials(input);
    const headers = result.mcpServers.remote.headers;
    expect(headers.Authorization).toBe("[STRIPPED_BY_MIGRATION]");
    expect(headers["X-API-Key"]).toBe("[STRIPPED_BY_MIGRATION]");
    expect(headers["X-API-Token"]).toBe("[STRIPPED_BY_MIGRATION]");
    expect(headers["X-Custom-Auth"]).toBe("[STRIPPED_BY_MIGRATION]");
    expect(headers["X-Auth-Token"]).toBe("Bearer openshell:resolve:env:REMOTE_MCP_TOKEN");
    expect(headers["X-Request-Id"]).toBe("req-12345");
    expect(result.mcpServers.remote.url).toBe("https://mcp.example.com");
  });

  it("scrubs secret strings and flag values inside array args (#5027)", () => {
    const input = {
      mcpServers: {
        cli: {
          command: "some-mcp",
          args: [
            "--api-key",
            "opaqueOpaqueSecret123", // opaque value after a credential flag
            "--verbose", // value-less flag must not be swallowed
            "--token=plainOpaque", // inline credential flag form
            "--name=server", // benign inline flag survives
            "ghp_0123456789abcdef", // shape-based catch
          ],
        },
      },
    };
    const result = stripCredentials(input);
    const args = result.mcpServers.cli.args;
    expect(args[0]).toBe("--api-key");
    expect(args[1]).toBe("[STRIPPED_BY_MIGRATION]");
    expect(args[2]).toBe("--verbose");
    expect(args[3]).toBe("--token=[STRIPPED_BY_MIGRATION]");
    expect(args[4]).toBe("--name=server");
    expect(args[5]).toBe("[STRIPPED_BY_MIGRATION]");
  });
});
