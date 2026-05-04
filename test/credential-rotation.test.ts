// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type ModuleProperty = string | number | boolean | Function | object | null | undefined;
type ModuleRecord = { [key: string]: ModuleProperty };

type MessagingProvider = {
  name: string;
  envKey: string;
  token: string | null;
};

type CredentialRotationInternals = {
  hashCredential: (value: string | null | undefined) => string | null;
  detectMessagingCredentialRotation: (
    sandboxName: string,
    providers: MessagingProvider[],
  ) => { changed: boolean; changedProviders: string[] };
};

function isRecord(value: object | null): value is ModuleRecord {
  return value !== null && !Array.isArray(value);
}

function isCredentialRotationInternals(value: object | null): value is CredentialRotationInternals {
  return (
    isRecord(value) &&
    typeof value.hashCredential === "function" &&
    typeof value.detectMessagingCredentialRotation === "function"
  );
}

function isRegistryModule(value: object | null): value is typeof import("../dist/lib/registry.js") {
  return isRecord(value) && typeof value.getSandbox === "function";
}

function loadCredentialRotationInternals(): CredentialRotationInternals {
  const loaded = require("../dist/lib/onboard.js");
  const record = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (!isCredentialRotationInternals(record)) {
    throw new Error("Expected onboard internals to expose credential rotation helpers");
  }
  return record;
}

function loadRegistryModule(): typeof import("../dist/lib/registry.js") {
  const loaded = require("../dist/lib/registry.js");
  const record = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (!isRegistryModule(record)) {
    throw new Error("Expected registry module to expose getSandbox");
  }
  return record;
}

describe("credential rotation detection", () => {
  let hashCredential: CredentialRotationInternals["hashCredential"];
  let detectMessagingCredentialRotation: CredentialRotationInternals["detectMessagingCredentialRotation"];
  let registry: typeof import("../dist/lib/registry.js");

  beforeEach(() => {
    // Fresh imports to avoid cross-test contamination
    ({ hashCredential, detectMessagingCredentialRotation } = loadCredentialRotationInternals());
    registry = loadRegistryModule();
  });

  function hashCredentialOrThrow(value: string): string {
    const hash = hashCredential(value);
    expect(hash).not.toBeNull();
    if (!hash) {
      throw new Error(`Expected hashCredential(${JSON.stringify(value)}) to return a hash`);
    }
    return hash;
  }

  describe("hashCredential", () => {
    it("returns null for falsy values", () => {
      expect(hashCredential(null)).toBeNull();
      expect(hashCredential("")).toBeNull();
      expect(hashCredential(undefined)).toBeNull();
    });

    it("returns null for whitespace-only values", () => {
      expect(hashCredential("   ")).toBeNull();
      expect(hashCredential("\r\n\t")).toBeNull();
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
      const tokenHash = hashCredentialOrThrow("same-token");
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
      const oldHash = hashCredentialOrThrow("old-token");
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
      const telegramHash = hashCredentialOrThrow("tg-old");
      const discordHash = hashCredentialOrThrow("dc-same");
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
      const hash = hashCredentialOrThrow("old-token");
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
