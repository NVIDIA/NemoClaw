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
