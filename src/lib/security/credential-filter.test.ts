// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isConfigValue,
  isCredentialField,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  sanitizeConfigFile,
  shouldScanSnapshotFileForCredentials,
  stripCredentials,
  valueLooksLikeSecret,
} from "./credential-filter.js";

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
    // OpenClaw channel token fields (#5027).
    expect(isCredentialField("botToken")).toBe(true);
    expect(isCredentialField("appToken")).toBe(true);
  });

  it("matches env-variable-style secret names (#5027)", () => {
    expect(isCredentialField("GITHUB_TOKEN")).toBe(true);
    expect(isCredentialField("BRAVE_API_KEY")).toBe(true);
    expect(isCredentialField("OPENAI_API_KEY")).toBe(true);
    expect(isCredentialField("DB_PASSWORD")).toBe(true);
    expect(isCredentialField("SLACK_APP_TOKEN")).toBe(true);
    // Bare uppercase secret words must also be scrubbed.
    expect(isCredentialField("TOKEN")).toBe(true);
    expect(isCredentialField("PASSWORD")).toBe(true);
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

describe("isSafeCredentialPlaceholder", () => {
  it("recognizes OpenShell resolve placeholders and the unused sentinel", () => {
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:DISCORD_BOT_TOKEN")).toBe(true);
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:BRAVE_API_KEY")).toBe(true);
    expect(isSafeCredentialPlaceholder("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN")).toBe(true);
    expect(isSafeCredentialPlaceholder("xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN")).toBe(true);
    expect(isSafeCredentialPlaceholder("unused")).toBe(true);
    expect(isSafeCredentialPlaceholder("[STRIPPED_BY_MIGRATION]")).toBe(true);
    expect(isSafeCredentialPlaceholder("Bearer openshell:resolve:env:REMOTE_MCP_TOKEN")).toBe(true);
    // `Bearer <safe-literal>` proxy-auth sentinels are preserved too.
    expect(isSafeCredentialPlaceholder("Bearer unused")).toBe(true);
    expect(isSafeCredentialPlaceholder("Bearer [STRIPPED_BY_MIGRATION]")).toBe(true);
  });

  it("rejects raw secrets and malformed references", () => {
    expect(isSafeCredentialPlaceholder("sk-1234567890")).toBe(false);
    expect(isSafeCredentialPlaceholder("xoxb-987654321-realtoken")).toBe(false);
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:")).toBe(false);
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:BAD NAME")).toBe(false);
    expect(isSafeCredentialPlaceholder(42)).toBe(false);
    expect(isSafeCredentialPlaceholder(null)).toBe(false);
  });
});

describe("isConfigValue", () => {
  it("accepts plain JSON-like configuration values", () => {
    expect(isConfigValue(null)).toBe(true);
    expect(isConfigValue("hello")).toBe(true);
    expect(isConfigValue(42)).toBe(true);
    expect(isConfigValue({ nested: [true, "value", { count: 1 }] })).toBe(true);
  });

  it("rejects non-JSON objects nested inside config values", () => {
    expect(isConfigValue({ when: new Date() })).toBe(false);
    expect(isConfigValue([new Map()])).toBe(false);
  });
});

describe("stripCredentials", () => {
  it("strips top-level credential fields", () => {
    const input = { model: "gpt-4", apiKey: "sk-123", name: "test" };
    const result = stripCredentials(input);
    expect(result.model).toBe("gpt-4");
    expect(result.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.name).toBe("test");
  });

  it("strips nested credential fields", () => {
    const input = { providers: { openai: { apiKey: "sk-123", model: "gpt-4" } } };
    const result = stripCredentials(input);
    expect(result.providers.openai.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.providers.openai.model).toBe("gpt-4");
  });

  it("strips credentials in arrays", () => {
    const input = { items: [{ token: "abc" }, { name: "safe" }] };
    const result = stripCredentials(input);
    expect(result.items[0].token).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.items[1].name).toBe("safe");
  });

  it("handles null and primitives", () => {
    expect(stripCredentials(null)).toBeNull();
    expect(stripCredentials(undefined)).toBeUndefined();
    expect(stripCredentials("hello")).toBe("hello");
    expect(stripCredentials(42)).toBe(42);
  });

  it("preserves OpenShell resolve placeholders under credential fields (#5027)", () => {
    const input = {
      models: { providers: { nvidia: { apiKey: "unused", baseUrl: "https://x/v1" } } },
      channels: {
        discord: { accounts: { default: { token: "openshell:resolve:env:DISCORD_BOT_TOKEN" } } },
        slack: {
          accounts: { default: { botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" } },
        },
      },
    };
    const result = stripCredentials(input);
    expect(result.models.providers.nvidia.apiKey).toBe("unused");
    expect(result.models.providers.nvidia.baseUrl).toBe("https://x/v1");
    expect(result.channels.discord.accounts.default.token).toBe(
      "openshell:resolve:env:DISCORD_BOT_TOKEN",
    );
    expect(result.channels.slack.accounts.default.botToken).toBe(
      "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    );
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

  it("still strips raw secrets even under preserved-style sibling fields", () => {
    const input = {
      good: { apiKey: "openshell:resolve:env:GOOD_KEY" },
      bad: { apiKey: "sk-actual-secret" },
    };
    const result = stripCredentials(input);
    expect(result.good.apiKey).toBe("openshell:resolve:env:GOOD_KEY");
    expect(result.bad.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
  });
});

describe("sanitizeConfigFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cred-filter-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips credentials and removes gateway section", () => {
    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "gpt-4",
        apiKey: "sk-secret",
        gateway: { port: 8080, authToken: "gw-token" },
      }),
    );

    sanitizeConfigFile(configPath);

    const result = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(result.model).toBe("gpt-4");
    expect(result.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.gateway).toBeUndefined();
  });

  it("sanitizes a realistic openclaw.json without breaking restorable settings (#5027)", () => {
    const configPath = join(tmpDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          mode: "merge",
          providers: {
            nvidia: { baseUrl: "https://x/v1", apiKey: "unused", models: [{ id: "kimi" }] },
          },
        },
        mcpServers: { fs: { command: "npx" } },
        channels: {
          discord: { accounts: { default: { token: "openshell:resolve:env:DISCORD_BOT_TOKEN" } } },
        },
        customAgents: { researcher: { prompt: "be thorough" } },
        leaked: { apiKey: "sk-real-secret" },
        gateway: { port: 18789, authToken: "gw-token" },
      }),
    );

    sanitizeConfigFile(configPath);

    const result = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(result.models.providers.nvidia.apiKey).toBe("unused");
    expect(result.models.providers.nvidia.models[0].id).toBe("kimi");
    expect(result.mcpServers.fs.command).toBe("npx");
    expect(result.channels.discord.accounts.default.token).toBe(
      "openshell:resolve:env:DISCORD_BOT_TOKEN",
    );
    expect(result.customAgents.researcher.prompt).toBe("be thorough");
    expect(result.leaked.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.gateway).toBeUndefined();
  });

  it("skips non-existent files", () => {
    sanitizeConfigFile(join(tmpDir, "nonexistent.json"));
    // Should not throw
  });

  it("skips invalid JSON", () => {
    const configPath = join(tmpDir, "bad.json");
    writeFileSync(configPath, "not json at all");
    sanitizeConfigFile(configPath);
    // Should not throw, file unchanged
    expect(readFileSync(configPath, "utf-8")).toBe("not json at all");
  });

  it("does not follow config-file symlinks while sanitizing", () => {
    const targetPath = join(tmpDir, "target.json");
    const linkPath = join(tmpDir, "openclaw.json");
    writeFileSync(targetPath, JSON.stringify({ apiKey: "sk-secret" }));
    try {
      symlinkSync(targetPath, linkPath);
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: string }).code : "";
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }

    sanitizeConfigFile(linkPath);

    expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual({ apiKey: "sk-secret" });
  });
});

describe("isSensitiveFile", () => {
  it("detects auth-profiles.json", () => {
    expect(isSensitiveFile("auth-profiles.json")).toBe(true);
    expect(isSensitiveFile("Auth-Profiles.json")).toBe(true);
    expect(isSensitiveFile("auth.json")).toBe(true);
    expect(isSensitiveFile("AUTH.JSON")).toBe(true);
  });

  it("does not flag normal files", () => {
    expect(isSensitiveFile("openclaw.json")).toBe(false);
    expect(isSensitiveFile("config.yaml")).toBe(false);
    expect(isSensitiveFile("SOUL.md")).toBe(false);
  });
});

describe("shouldScanSnapshotFileForCredentials", () => {
  it("scans runtime config and env files", () => {
    expect(shouldScanSnapshotFileForCredentials("openclaw.json")).toBe(true);
    expect(shouldScanSnapshotFileForCredentials("config.json")).toBe(true);
    expect(shouldScanSnapshotFileForCredentials(".env")).toBe(true);
    expect(shouldScanSnapshotFileForCredentials("service.env")).toBe(true);
  });

  it("skips dependency lockfiles that can contain non-secret package metadata matches", () => {
    expect(shouldScanSnapshotFileForCredentials("package-lock.json")).toBe(false);
    expect(shouldScanSnapshotFileForCredentials("npm-shrinkwrap.json")).toBe(false);
    expect(shouldScanSnapshotFileForCredentials("yarn.lock")).toBe(false);
    expect(shouldScanSnapshotFileForCredentials("pnpm-lock.yaml")).toBe(false);
  });

  it("applies lockfile exclusions to paths by basename", () => {
    expect(shouldScanSnapshotFileForCredentials("/tmp/snapshot/package-lock.json")).toBe(false);
    expect(shouldScanSnapshotFileForCredentials("/tmp/snapshot/config.json")).toBe(true);
  });
});
