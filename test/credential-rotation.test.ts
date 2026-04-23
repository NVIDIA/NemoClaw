// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("credential rotation detection", () => {
  let hashCredential;
  let detectMessagingCredentialRotation;
  let registry;

  beforeEach(() => {
    // Fresh imports to avoid cross-test contamination
    ({ hashCredential, detectMessagingCredentialRotation } = require("../dist/lib/onboard.js"));
    registry = require("../dist/lib/registry.js");
  });

  describe("hashCredential", () => {
    it("returns null for falsy values", () => {
      expect(hashCredential(null)).toBeNull();
      expect(hashCredential("")).toBeNull();
      expect(hashCredential(undefined)).toBeNull();
    });

    it("returns a 64-char hex SHA-256 hash for valid input", () => {
      const hash = hashCredential("my-secret-token");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces consistent hashes for the same input", () => {
      const a = hashCredential("token-abc");
      const b = hashCredential("token-abc");
      expect(a).toBe(b);
    });

    it("produces different hashes for different inputs", () => {
      const a = hashCredential("token-A");
      const b = hashCredential("token-B");
      expect(a).not.toBe(b);
    });

    it("trims whitespace before hashing", () => {
      const a = hashCredential("  token  ");
      const b = hashCredential("token");
      expect(a).toBe(b);
    });
  });

  describe("detectMessagingCredentialRotation", () => {
    it("returns changed: false when no hashes are stored (legacy sandbox)", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "test-sandbox",
        // no providerCredentialHashes
      });

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "new-token" },
      ]);

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });

    it("returns changed: false when hashes match", () => {
      const tokenHash = hashCredential("same-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "test-sandbox",
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: tokenHash },
      });

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "same-token" },
      ]);

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });

    it("returns changed: true with correct provider names when hashes differ", () => {
      const oldHash = hashCredential("old-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "test-sandbox",
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: oldHash },
      });

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "new-token" },
      ]);

      expect(result.changed).toBe(true);
      expect(result.changedProviders).toEqual(["test-telegram-bridge"]);
      vi.restoreAllMocks();
    });

    it("detects rotation across multiple providers", () => {
      const telegramHash = hashCredential("tg-old");
      const discordHash = hashCredential("dc-same");
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "test-sandbox",
        providerCredentialHashes: {
          TELEGRAM_BOT_TOKEN: telegramHash,
          DISCORD_BOT_TOKEN: discordHash,
        },
      });

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "tg-new" },
        { name: "test-discord-bridge", envKey: "DISCORD_BOT_TOKEN", token: "dc-same" },
      ]);

      expect(result.changed).toBe(true);
      expect(result.changedProviders).toEqual(["test-telegram-bridge"]);
      vi.restoreAllMocks();
    });

    it("skips providers with null tokens", () => {
      const hash = hashCredential("old-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "test-sandbox",
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: hash },
      });

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: null },
      ]);

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });

    it("returns changed: false when sandbox is not found", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue(null);

      const result = detectMessagingCredentialRotation("nonexistent", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "token" },
      ]);

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });
  });
});
