// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function isRegistryModule(
  value: object | null,
): value is typeof import("../src/lib/state/registry.js") {
  return isRecord(value) && typeof value.getSandbox === "function";
}

function loadCredentialRotationInternals(): CredentialRotationInternals {
  const loaded = require("../src/lib/onboard.js");
  const record = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (!isCredentialRotationInternals(record)) {
    throw new Error("Expected onboard internals to expose credential rotation helpers");
  }
  return record;
}

function loadRegistryModule(): typeof import("../src/lib/state/registry.js") {
  const loaded = require("../src/lib/state/registry.js");
  const record = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (!isRegistryModule(record)) {
    throw new Error("Expected registry module to expose getSandbox");
  }
  return record;
}

describe("credential rotation detection", () => {
  let hashCredential: CredentialRotationInternals["hashCredential"];
  let detectMessagingCredentialRotation: CredentialRotationInternals["detectMessagingCredentialRotation"];
  let registry: typeof import("../src/lib/state/registry.js");

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

  function makePlanEntry(
    name: string,
    bindings: Array<{ providerEnvKey: string; credentialHash?: string }>,
  ) {
    return {
      name,
      messaging: {
        schemaVersion: 1 as const,
        plan: {
          schemaVersion: 1 as const,
          sandboxName: name,
          agent: "openclaw" as const,
          workflow: "onboard" as const,
          channels: [],
          disabledChannels: [],
          credentialBindings: bindings.map((b) => ({
            channelId: "telegram" as const,
            credentialId: "telegramBotToken",
            sourceInput: "botToken",
            providerName: `${name}-telegram-bridge`,
            providerEnvKey: b.providerEnvKey,
            placeholder: `openshell:resolve:env:${b.providerEnvKey}`,
            credentialAvailable: true,
            ...(b.credentialHash ? { credentialHash: b.credentialHash } : {}),
          })),
          networkPolicy: { presets: [], entries: [] },
          agentRender: [],
          buildSteps: [],
          stateUpdates: [],
          healthChecks: [],
        },
      },
    };
  }

  describe("detectMessagingCredentialRotation", () => {
    it("returns changed: false when no plan is stored (pre-plan sandbox)", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "test-sandbox" });

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "new-token" },
      ]);

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });

    it("returns changed: false when hashes match", () => {
      const tokenHash = hashCredentialOrThrow("same-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        makePlanEntry("test-sandbox", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: tokenHash },
        ]),
      );

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "same-token" },
      ]);

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });

    it("returns changed: true with correct provider names when hashes differ", () => {
      const oldHash = hashCredentialOrThrow("old-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        makePlanEntry("test-sandbox", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: oldHash },
        ]),
      );

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
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        makePlanEntry("test-sandbox", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: telegramHash },
          { providerEnvKey: "DISCORD_BOT_TOKEN", credentialHash: discordHash },
        ]),
      );

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "tg-new" },
        { name: "test-discord-bridge", envKey: "DISCORD_BOT_TOKEN", token: "dc-same" },
      ]);

      expect(result.changed).toBe(true);
      expect(result.changedProviders).toEqual(["test-telegram-bridge"]);
      vi.restoreAllMocks();
    });

    it("treats removed tokens as changed providers", () => {
      const hash = hashCredentialOrThrow("old-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        makePlanEntry("test-sandbox", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: hash },
        ]),
      );

      const result = detectMessagingCredentialRotation("test-sandbox", [
        { name: "test-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: null },
      ]);

      expect(result.changed).toBe(true);
      expect(result.changedProviders).toEqual(["test-telegram-bridge"]);
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

  // The selective-rebuild contract: when only a subset of messaging credentials
  // rotate, the provider-name list that drives the user-facing
  // "Messaging credential(s) rotated: …" line and the rebuild set must name
  // ONLY the changed provider(s) — never their unchanged siblings. onboard.ts
  // renders this via `credentialRotation.changedProviders.join(", ")`, so these
  // cases assert on that exact provider-name selection rather than the boolean
  // rotation / hash logic covered above.
  describe("selective-rebuild provider naming", () => {
    // Three sibling providers sharing a single stored plan; each case rotates a
    // different subset and asserts the resulting name list.
    function threeProviderPlan(hashes: { telegram: string; discord: string; slack: string }) {
      return makePlanEntry("multi-sandbox", [
        { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: hashes.telegram },
        { providerEnvKey: "DISCORD_BOT_TOKEN", credentialHash: hashes.discord },
        { providerEnvKey: "SLACK_BOT_TOKEN", credentialHash: hashes.slack },
      ]);
    }

    const A = "multi-telegram-bridge";
    const B = "multi-discord-bridge";
    const C = "multi-slack-bridge";

    it("names ONLY provider A and excludes unchanged siblings B and C", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        threeProviderPlan({
          telegram: hashCredentialOrThrow("tg-old"),
          discord: hashCredentialOrThrow("dc-same"),
          slack: hashCredentialOrThrow("sl-same"),
        }),
      );

      const result = detectMessagingCredentialRotation("multi-sandbox", [
        { name: A, envKey: "TELEGRAM_BOT_TOKEN", token: "tg-new" },
        { name: B, envKey: "DISCORD_BOT_TOKEN", token: "dc-same" },
        { name: C, envKey: "SLACK_BOT_TOKEN", token: "sl-same" },
      ]);

      expect(result.changed).toBe(true);
      // Rebuild set / message name only the rotated provider.
      expect(result.changedProviders).toEqual([A]);
      expect(result.changedProviders).not.toContain(B);
      expect(result.changedProviders).not.toContain(C);
      // The exact user-facing string driven by this list.
      expect(result.changedProviders.join(", ")).toBe(A);
      vi.restoreAllMocks();
    });

    it("names a middle sibling only, leaving A and C out of the rebuild set", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        threeProviderPlan({
          telegram: hashCredentialOrThrow("tg-same"),
          discord: hashCredentialOrThrow("dc-old"),
          slack: hashCredentialOrThrow("sl-same"),
        }),
      );

      const result = detectMessagingCredentialRotation("multi-sandbox", [
        { name: A, envKey: "TELEGRAM_BOT_TOKEN", token: "tg-same" },
        { name: B, envKey: "DISCORD_BOT_TOKEN", token: "dc-new" },
        { name: C, envKey: "SLACK_BOT_TOKEN", token: "sl-same" },
      ]);

      expect(result.changedProviders).toEqual([B]);
      expect(result.changedProviders.join(", ")).toBe(B);
      vi.restoreAllMocks();
    });

    it("names all changed providers when multiple siblings rotate, preserving order", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        threeProviderPlan({
          telegram: hashCredentialOrThrow("tg-old"),
          discord: hashCredentialOrThrow("dc-same"),
          slack: hashCredentialOrThrow("sl-old"),
        }),
      );

      const result = detectMessagingCredentialRotation("multi-sandbox", [
        { name: A, envKey: "TELEGRAM_BOT_TOKEN", token: "tg-new" },
        { name: B, envKey: "DISCORD_BOT_TOKEN", token: "dc-same" },
        { name: C, envKey: "SLACK_BOT_TOKEN", token: "sl-new" },
      ]);

      expect(result.changed).toBe(true);
      // Both changed siblings named, in tokenDefs order; unchanged B omitted.
      expect(result.changedProviders).toEqual([A, C]);
      expect(result.changedProviders).not.toContain(B);
      expect(result.changedProviders.join(", ")).toBe(`${A}, ${C}`);
      vi.restoreAllMocks();
    });

    it("names every provider when all siblings rotate", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        threeProviderPlan({
          telegram: hashCredentialOrThrow("tg-old"),
          discord: hashCredentialOrThrow("dc-old"),
          slack: hashCredentialOrThrow("sl-old"),
        }),
      );

      const result = detectMessagingCredentialRotation("multi-sandbox", [
        { name: A, envKey: "TELEGRAM_BOT_TOKEN", token: "tg-new" },
        { name: B, envKey: "DISCORD_BOT_TOKEN", token: "dc-new" },
        { name: C, envKey: "SLACK_BOT_TOKEN", token: "sl-new" },
      ]);

      expect(result.changedProviders).toEqual([A, B, C]);
      expect(result.changedProviders.join(", ")).toBe(`${A}, ${B}, ${C}`);
      vi.restoreAllMocks();
    });

    it("produces an empty name list when no sibling rotates (no rebuild, no message)", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        threeProviderPlan({
          telegram: hashCredentialOrThrow("tg-same"),
          discord: hashCredentialOrThrow("dc-same"),
          slack: hashCredentialOrThrow("sl-same"),
        }),
      );

      const result = detectMessagingCredentialRotation("multi-sandbox", [
        { name: A, envKey: "TELEGRAM_BOT_TOKEN", token: "tg-same" },
        { name: B, envKey: "DISCORD_BOT_TOKEN", token: "dc-same" },
        { name: C, envKey: "SLACK_BOT_TOKEN", token: "sl-same" },
      ]);

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      expect(result.changedProviders.join(", ")).toBe("");
      vi.restoreAllMocks();
    });
  });
});
