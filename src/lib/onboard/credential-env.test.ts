// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { hydrateCredentialEnv } from "../../../dist/lib/onboard/credential-env";

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
