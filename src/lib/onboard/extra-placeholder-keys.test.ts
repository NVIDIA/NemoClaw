// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  EXTRA_PLACEHOLDER_KEYS_ENV,
  EXTRA_PLACEHOLDER_KEYS_MAX,
  extraPlaceholderProviderSlug,
  parseExtraPlaceholderKeys,
} from "./extra-placeholder-keys";

describe("parseExtraPlaceholderKeys", () => {
  it("returns empty result for unset, blank, or whitespace-only input", () => {
    expect(parseExtraPlaceholderKeys(undefined)).toEqual({ keys: [], warnings: [] });
    expect(parseExtraPlaceholderKeys(null)).toEqual({ keys: [], warnings: [] });
    expect(parseExtraPlaceholderKeys("")).toEqual({ keys: [], warnings: [] });
    expect(parseExtraPlaceholderKeys("   \t  ")).toEqual({ keys: [], warnings: [] });
  });

  it("accepts whitespace- and comma-separated upper-snake tokens", () => {
    const result = parseExtraPlaceholderKeys(
      "TELEGRAM_BOT_TOKEN_AGENT_A TELEGRAM_BOT_TOKEN_AGENT_B,DISCORD_BOT_TOKEN_AGENT_C\tBRAVE_API_KEY_AGENT_D",
    );
    expect(result.keys).toEqual([
      "TELEGRAM_BOT_TOKEN_AGENT_A",
      "TELEGRAM_BOT_TOKEN_AGENT_B",
      "DISCORD_BOT_TOKEN_AGENT_C",
      "BRAVE_API_KEY_AGENT_D",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects tokens that do not match the upper-snake pattern with a single warning each", () => {
    const result = parseExtraPlaceholderKeys("telegram_bot_token 9NUM_START Path$Bad VALID_KEY");
    expect(result.keys).toEqual(["VALID_KEY"]);
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "telegram_bot_token" — must match /^[A-Z][A-Z0-9_]{0,127}$/`,
    );
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "9NUM_START" — must match /^[A-Z][A-Z0-9_]{0,127}$/`,
    );
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "Path$Bad" — must match /^[A-Z][A-Z0-9_]{0,127}$/`,
    );
  });

  it("rejects the control env NEMOCLAW_EXTRA_PLACEHOLDER_KEYS when supplied as an entry", () => {
    // An operator who lists the control env itself must not register a generic
    // provider whose token would resolve to the raw key-list string. The
    // canonical reserved set produced by reservedPlaceholderKeysFromChannels()
    // already adds this name; the parser-level rejection here makes the
    // contract explicit and the warning observable.
    const reserved = new Set<string>([EXTRA_PLACEHOLDER_KEYS_ENV]);
    const result = parseExtraPlaceholderKeys(
      `${EXTRA_PLACEHOLDER_KEYS_ENV} VALID_EXTRA`,
      reserved,
    );
    expect(result.keys).toEqual(["VALID_EXTRA"]);
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "${EXTRA_PLACEHOLDER_KEYS_ENV}" — collides with a canonical channel envKey`,
    );
  });

  it("rejects tokens that collide with the reserved canonical channel envKeys", () => {
    const reserved = new Set([
      "TELEGRAM_BOT_TOKEN",
      "DISCORD_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "WECHAT_BOT_TOKEN",
      "BRAVE_API_KEY",
    ]);
    const result = parseExtraPlaceholderKeys(
      "TELEGRAM_BOT_TOKEN TELEGRAM_BOT_TOKEN_AGENT_A BRAVE_API_KEY",
      reserved,
    );
    expect(result.keys).toEqual(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "TELEGRAM_BOT_TOKEN" — collides with a canonical channel envKey`,
    );
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "BRAVE_API_KEY" — collides with a canonical channel envKey`,
    );
  });

  it("dedupes repeated tokens without emitting a warning", () => {
    const result = parseExtraPlaceholderKeys("KEY_A KEY_A KEY_B KEY_A");
    expect(result.keys).toEqual(["KEY_A", "KEY_B"]);
    expect(result.warnings).toEqual([]);
  });

  it("caps the parsed list at EXTRA_PLACEHOLDER_KEYS_MAX entries and warns about the remainder", () => {
    const tokens = Array.from({ length: EXTRA_PLACEHOLDER_KEYS_MAX + 5 }, (_, i) => `KEY_${i}`);
    const result = parseExtraPlaceholderKeys(tokens.join(" "));
    expect(result.keys).toHaveLength(EXTRA_PLACEHOLDER_KEYS_MAX);
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: capped at ${EXTRA_PLACEHOLDER_KEYS_MAX} entries; remaining tokens ignored`,
    );
  });
});

describe("extraPlaceholderProviderSlug", () => {
  it("lowercases and hyphenates upper-snake env keys", () => {
    expect(extraPlaceholderProviderSlug("TELEGRAM_BOT_TOKEN_AGENT_A")).toBe(
      "telegram-bot-token-agent-a",
    );
    expect(extraPlaceholderProviderSlug("KEY")).toBe("key");
  });
});
