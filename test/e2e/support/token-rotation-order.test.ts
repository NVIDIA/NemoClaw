// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildSequentialTokenRotationSteps,
  parseTokenRotationOrder,
  TOKEN_ROTATION_ORDER_ENV,
  TOKEN_ROTATION_PROVIDER_SUFFIXES,
  type TokenRotationTokenSet,
  tokenRotationPhaseNames,
} from "../fixtures/token-rotation-order.ts";

const TOKEN_A: TokenRotationTokenSet = {
  telegram: "telegram-a",
  discord: "discord-a",
  slackBot: "slack-bot-a",
  slackApp: "slack-app-a",
};

const TOKEN_B: TokenRotationTokenSet = {
  telegram: "telegram-b",
  discord: "discord-b",
  slackBot: "slack-bot-b",
  slackApp: "slack-app-b",
};

describe("token-rotation provider order", () => {
  it("defaults to Discord-first so the hosted diagnostic run reverses historical coverage", () => {
    expect(parseTokenRotationOrder(undefined)).toBe("discord-first");
    expect(parseTokenRotationOrder("")).toBe("discord-first");
    expect(parseTokenRotationOrder("  ")).toBe("discord-first");
  });

  it("accepts only the two explicit provider-order selectors", () => {
    expect(parseTokenRotationOrder("telegram-first")).toBe("telegram-first");
    expect(parseTokenRotationOrder("discord-first")).toBe("discord-first");
    expect(parseTokenRotationOrder(" discord-first ")).toBe("discord-first");

    for (const selector of ["Discord-first", "slack-first", "discord-first; exit 0"]) {
      expect(() => parseTokenRotationOrder(selector)).toThrow(
        `${TOKEN_ROTATION_ORDER_ENV} must be 'telegram-first' or 'discord-first'.`,
      );
    }
  });

  it("keeps the existing Telegram-first sequence and accumulates only completed rotations", () => {
    const steps = buildSequentialTokenRotationSteps("telegram-first", TOKEN_A, TOKEN_B);

    expect(steps).toEqual([
      expect.objectContaining({
        provider: "telegram",
        displayName: "Telegram",
        artifactSlug: "telegram",
        phaseNumber: 2,
        reusePhaseNumber: 3,
        providerSuffixes: ["telegram-bridge"],
        tokens: { ...TOKEN_A, telegram: TOKEN_B.telegram },
      }),
      expect.objectContaining({
        provider: "discord",
        displayName: "Discord",
        artifactSlug: "discord",
        phaseNumber: 4,
        reusePhaseNumber: 5,
        providerSuffixes: ["discord-bridge"],
        tokens: {
          ...TOKEN_A,
          telegram: TOKEN_B.telegram,
          discord: TOKEN_B.discord,
        },
      }),
    ]);
  });

  it("reverses Telegram and Discord without changing cumulative token isolation", () => {
    const steps = buildSequentialTokenRotationSteps("discord-first", TOKEN_A, TOKEN_B);

    expect(steps).toEqual([
      expect.objectContaining({
        provider: "discord",
        displayName: "Discord",
        artifactSlug: "discord",
        phaseNumber: 2,
        reusePhaseNumber: 3,
        providerSuffixes: ["discord-bridge"],
        tokens: { ...TOKEN_A, discord: TOKEN_B.discord },
      }),
      expect.objectContaining({
        provider: "telegram",
        displayName: "Telegram",
        artifactSlug: "telegram",
        phaseNumber: 4,
        reusePhaseNumber: 5,
        providerSuffixes: ["telegram-bridge"],
        tokens: {
          ...TOKEN_A,
          telegram: TOKEN_B.telegram,
          discord: TOKEN_B.discord,
        },
      }),
    ]);
    expect(steps.every((step) => step.tokens.slackBot === TOKEN_A.slackBot)).toBe(true);
    expect(steps.every((step) => step.tokens.slackApp === TOKEN_A.slackApp)).toBe(true);
  });

  it("builds phase metadata and provider-exclusion sets from the selected order", () => {
    const steps = buildSequentialTokenRotationSteps("discord-first", TOKEN_A, TOKEN_B);

    expect(tokenRotationPhaseNames(steps)).toEqual([
      "rotate only the Discord provider",
      "reuse the sandbox after the unchanged Discord token",
      "rotate only the Telegram provider",
      "reuse the sandbox after the unchanged Telegram token",
    ]);
    for (const step of steps) {
      const expected = new Set<string>(step.providerSuffixes);
      expect(TOKEN_ROTATION_PROVIDER_SUFFIXES.filter((suffix) => expected.has(suffix))).toEqual(
        step.providerSuffixes,
      );
      expect(
        TOKEN_ROTATION_PROVIDER_SUFFIXES.filter((suffix) => !expected.has(suffix)),
      ).toHaveLength(3);
    }
  });
});
