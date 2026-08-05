// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isConfigValue,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  sanitizeConfigFile,
  sanitizeEnvFile,
  sanitizeEnvFileContent,
  sanitizeYamlConfigFile,
  shouldScanSnapshotFileForCredentials,
  stripCredentials,
} from "./credential-filter.js";

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

  it("preserves null and undefined under credential field names", () => {
    const result = stripCredentials({ apiKey: null, token: undefined, model: "keep" });
    expect(result.apiKey).toBeNull();
    expect(result.token).toBeUndefined();
    expect(result.model).toBe("keep");
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

  it("strips Hermes YAML credentials and removes gateway", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "model: hermes",
        "api_key: sk-hermes-secret-key-value",
        "botToken: xoxb-slack-bot-token-value",
        "publicKey: keep-me",
        "gateway:",
        "  authToken: gw-token",
        "env:",
        "  GITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "  NODE_ENV: production",
        "",
      ].join("\n"),
    );

    expect(sanitizeConfigFile(configPath)).toBe(true);

    const result = readFileSync(configPath, "utf-8");
    expect(result).toContain("model: hermes");
    expect(result).toContain("publicKey: keep-me");
    expect(result).toContain("NODE_ENV: production");
    expect(result).toContain("[STRIPPED_BY_MIGRATION]");
    expect(result).not.toContain("sk-hermes-secret-key-value");
    expect(result).not.toContain("xoxb-slack-bot-token-value");
    expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result).not.toContain("gateway:");
  });

  it("fails closed for malformed Hermes YAML", () => {
    const configPath = join(tmpDir, "broken.yaml");
    writeFileSync(configPath, "api_key: [unclosed\n");
    expect(sanitizeYamlConfigFile(configPath)).toBe(false);
    expect(sanitizeConfigFile(configPath)).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toContain("api_key:");
  });

  it("returns failure without changing the source when a YAML rewrite fails", () => {
    const configPath = join(tmpDir, "config.yaml");
    const source = "api_key: sk-hermes-secret-key-value\n";
    writeFileSync(configPath, source);

    expect(
      sanitizeYamlConfigFile(configPath, () => {
        throw new Error("injected rewrite failure");
      }),
    ).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(source);
  });

  it("preserves empty and comment-only YAML documents", () => {
    for (const [name, source] of [
      ["empty.yaml", ""],
      ["comments.yaml", "# nothing to sanitize\n"],
    ]) {
      const configPath = join(tmpDir, name);
      writeFileSync(configPath, source);
      expect(sanitizeYamlConfigFile(configPath)).toBe(true);
      expect(readFileSync(configPath, "utf-8")).toBe(source);
    }
  });

  it("sanitizes valid JSON arrays instead of treating them as failures", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify([{ apiKey: "sk-secret-value-long-enough" }]));

    expect(sanitizeConfigFile(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual([
      { apiKey: "[STRIPPED_BY_MIGRATION]" },
    ]);
  });
});

describe("sanitizeEnvFileContent", () => {
  it("strips PASS/TOKEN secrets without over-matching KEYBOARD_LAYOUT", () => {
    const input = [
      "# comment",
      "NODE_ENV=production",
      "KEYBOARD_LAYOUT=us",
      "DB_PASS=super-secret",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "API_KEY=openshell:resolve:env:API_KEY",
      "PASSPHRASE=raw-passphrase",
      "",
    ].join("\n");

    const result = sanitizeEnvFileContent(input);
    expect(result).toContain("NODE_ENV=production");
    expect(result).toContain("KEYBOARD_LAYOUT=us");
    expect(result).toContain("DB_PASS=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("GITHUB_TOKEN=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("API_KEY=openshell:resolve:env:API_KEY");
    expect(result).toContain("PASSPHRASE=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("# comment");
  });

  it("strips credential keys that use a leading export prefix", () => {
    const input = [
      "export DB_PASS=super-secret",
      "export NODE_ENV=production",
      "  export  GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "",
    ].join("\n");

    const result = sanitizeEnvFileContent(input);
    expect(result).toContain("export DB_PASS=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("export NODE_ENV=production");
    expect(result).toContain("export  GITHUB_TOKEN=[STRIPPED_BY_MIGRATION]");
    expect(result).not.toContain("super-secret");
    expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("strips secret-shaped values stored under benign keys", () => {
    const input = [
      "MODEL=keep-me",
      "CUSTOM=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "ENDPOINT=Bearer opaque-migration-secret",
      "SAFE=openshell:resolve:env:SAFE",
      "",
    ].join("\n");

    const result = sanitizeEnvFileContent(input);
    expect(result).toContain("MODEL=keep-me");
    expect(result).toContain("CUSTOM=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("ENDPOINT=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("SAFE=openshell:resolve:env:SAFE");
  });
});

describe("sanitizeEnvFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cred-env-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites .env credentials in place", () => {
    const envPath = join(tmpDir, ".env");
    writeFileSync(envPath, "DB_PASS=secret\nLOG_LEVEL=info\n");
    expect(sanitizeEnvFile(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf-8")).toBe(
      "DB_PASS=[STRIPPED_BY_MIGRATION]\nLOG_LEVEL=info\n",
    );
  });

  it("returns failure without changing the source when an env rewrite fails", () => {
    const envPath = join(tmpDir, ".env");
    const source = "DB_PASS=secret\n";
    writeFileSync(envPath, source);

    expect(
      sanitizeEnvFile(envPath, () => {
        throw new Error("injected rewrite failure");
      }),
    ).toBe(false);
    expect(readFileSync(envPath, "utf-8")).toBe(source);
  });
});

describe("isSensitiveFile", () => {
  it("detects credential-bearing auth state basenames", () => {
    expect(isSensitiveFile("auth-profiles.json")).toBe(true);
    expect(isSensitiveFile("Auth-Profiles.json")).toBe(true);
    expect(isSensitiveFile("auth.json")).toBe(true);
    expect(isSensitiveFile("AUTH.JSON")).toBe(true);
    expect(isSensitiveFile("chatgpt-auth.json")).toBe(true);
    expect(isSensitiveFile("CHATGPT-AUTH.JSON")).toBe(true);
  });

  it("does not flag normal files", () => {
    expect(isSensitiveFile("openclaw.json")).toBe(false);
    expect(isSensitiveFile("config.yaml")).toBe(false);
    expect(isSensitiveFile("SOUL.md")).toBe(false);
  });
});

describe("shouldScanSnapshotFileForCredentials", () => {
  it("scans runtime config, env, and Hermes YAML files", () => {
    expect(shouldScanSnapshotFileForCredentials("openclaw.json")).toBe(true);
    expect(shouldScanSnapshotFileForCredentials("config.json")).toBe(true);
    expect(shouldScanSnapshotFileForCredentials(".env")).toBe(true);
    expect(shouldScanSnapshotFileForCredentials("service.env")).toBe(true);
    expect(shouldScanSnapshotFileForCredentials("config.yaml")).toBe(true);
    expect(shouldScanSnapshotFileForCredentials("config.yml")).toBe(true);
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
    expect(shouldScanSnapshotFileForCredentials("/tmp/snapshot/config.yaml")).toBe(true);
  });
});
