// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { collectCredentialEnvSensitiveValues, hydrateCredentialEnv } from "./credential-env";
import { buildMessagingCredentialRecreateDiagnosticLines } from "./messaging-credentials";

const ORIGINAL_TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  if (ORIGINAL_TELEGRAM_TOKEN === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_TELEGRAM_TOKEN;
  }
});

describe("hydrateCredentialEnv", () => {
  it("returns null for empty env names", () => {
    expect(hydrateCredentialEnv(null)).toBeNull();
    expect(hydrateCredentialEnv(undefined)).toBeNull();
    expect(hydrateCredentialEnv("")).toBeNull();
  });

  it("delegates credential resolution and preserves process.env hydration side effects", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    const hydrated = hydrateCredentialEnv("TELEGRAM_BOT_TOKEN", (envName) => {
      if (envName !== "TELEGRAM_BOT_TOKEN") return null;
      process.env[envName] = "stored-telegram-token";
      return process.env[envName] || null;
    });
    const missing = hydrateCredentialEnv("NONEXISTENT_KEY", () => null);

    expect(hydrated).toBe("stored-telegram-token");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("stored-telegram-token");
    expect(missing).toBeNull();
  });
});

describe("collectCredentialEnvSensitiveValues", () => {
  it("collects supported and conventionally named credentials without benign values", () => {
    expect(
      collectCredentialEnvSensitiveValues(
        {
          COMPATIBLE_API_KEY: "opaque-compatible-key",
          CUSTOM_AUTH_TOKEN: "opaque-auth-token",
          PATH: "/usr/bin",
          LOG_LEVEL: "debug",
        },
        ["opaque-messaging-token", "opaque-compatible-key", null],
      ),
    ).toEqual(["opaque-compatible-key", "opaque-auth-token", "opaque-messaging-token"]);
  });
});

describe("credential recreation diagnostic inputs", () => {
  it("records provider identities and change categories without token values or hashes", () => {
    const lines = buildMessagingCredentialRecreateDiagnosticLines(
      [
        { name: "sandbox-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "secret-a" },
        { name: "sandbox-discord-bridge", envKey: "DISCORD_BOT_TOKEN", token: "secret-b" },
      ],
      ["sandbox-discord-bridge"],
    );

    expect(lines).toEqual([
      "recreate_reason=messaging_credential_rotation",
      "provider_identities=sandbox-discord-bridge,sandbox-telegram-bridge",
      "changed_credential_hash_providers=sandbox-discord-bridge",
      "unchanged_credential_hash_providers=sandbox-telegram-bridge",
    ]);
    expect(lines.join("\n")).not.toContain("secret-a");
    expect(lines.join("\n")).not.toContain("secret-b");
  });
});
