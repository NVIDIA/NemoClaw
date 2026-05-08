// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import {
  isConfigValue,
  isCredentialField,
  stripCredentials,
  sanitizeConfigFile,
  isSensitiveFile,
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
  });

  it("does not match safe field names", () => {
    expect(isCredentialField("name")).toBe(false);
    expect(isCredentialField("model")).toBe(false);
    expect(isCredentialField("provider")).toBe(false);
    expect(isCredentialField("endpoint")).toBe(false);
    expect(isCredentialField("version")).toBe(false);
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
