// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

const {
  computeSetupPresetSuggestions,
  filterSetupPolicyPresets,
  getSuggestedPolicyPresets,
} = require("../dist/lib/onboard") as {
  computeSetupPresetSuggestions: (
    tierName: string,
    options: {
      enabledChannels?: string[] | null;
      knownPresetNames: string[];
      provider?: string | null;
      webSearchConfig?: { provider?: string | null } | null;
      webSearchSupported?: boolean | null;
    },
  ) => string[];
  filterSetupPolicyPresets: <T extends { name: string }>(
    presets: T[],
    options?: { webSearchSupported?: boolean | null },
  ) => T[];
  getSuggestedPolicyPresets: (options?: {
    enabledChannels?: string[] | null;
    provider?: string | null;
  }) => string[];
};

describe("onboard policy preset suggestions", () => {
  const known = [
    "npm",
    "pypi",
    "huggingface",
    "brew",
    "brave",
    "slack",
    "discord",
    "telegram",
    "jira",
    "outlook",
    "local-inference",
  ];

  it("uses explicit messaging selections for policy suggestions when provided", () => {
    const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalDiscordBotToken = process.env.DISCORD_BOT_TOKEN;
    const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
    process.env.DISCORD_BOT_TOKEN = "discord-token";
    process.env.SLACK_BOT_TOKEN = "slack-token";
    try {
      expect(getSuggestedPolicyPresets({ enabledChannels: [] })).toEqual(["pypi", "npm"]);
      expect(getSuggestedPolicyPresets({ enabledChannels: ["telegram"] })).toEqual([
        "pypi",
        "npm",
        "telegram",
      ]);
      expect(getSuggestedPolicyPresets({ enabledChannels: ["discord", "slack"] })).toEqual([
        "pypi",
        "npm",
        "slack",
        "discord",
      ]);
    } finally {
      if (originalTelegramBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalTelegramBotToken;
      if (originalDiscordBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = originalDiscordBotToken;
      if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
    }
  });

  it("suggests local-inference preset for local providers only", () => {
    const ollamaPresets = getSuggestedPolicyPresets({ provider: "ollama-local" });
    expect(ollamaPresets).toContain("local-inference");
    expect(ollamaPresets).toContain("pypi");
    expect(ollamaPresets).toContain("npm");

    expect(getSuggestedPolicyPresets({ provider: "vllm-local" })).toContain("local-inference");
    expect(getSuggestedPolicyPresets({ provider: "nvidia-prod" })).not.toContain("local-inference");
    expect(getSuggestedPolicyPresets({ provider: "openai-api" })).not.toContain("local-inference");
    expect(getSuggestedPolicyPresets({ provider: null })).not.toContain("local-inference");
    expect(getSuggestedPolicyPresets({})).not.toContain("local-inference");
  });

  it("returns balanced tier defaults without messaging presets when no channels enabled", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: known,
    });
    expect(suggestions).toEqual(["npm", "pypi", "huggingface", "brew", "brave"]);
  });

  it("filters tier defaults to known presets for agent-specific onboarding", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: known.filter((name) => name !== "brave"),
    });
    expect(suggestions).toEqual(["npm", "pypi", "huggingface", "brew"]);
  });

  it("omits Brave when web search is unsupported", () => {
    const allPresets = known.map((name) => ({ name }));
    const unsupportedPresets = filterSetupPolicyPresets(allPresets, {
      webSearchSupported: false,
    }).map((p) => p.name);
    const supportedPresets = filterSetupPolicyPresets(allPresets, {
      webSearchSupported: true,
    }).map((p) => p.name);
    expect(unsupportedPresets).not.toContain("brave");
    expect(supportedPresets).toContain("brave");
  });

  it("drops Brave tier defaults when web search is unsupported", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: known,
      webSearchSupported: false,
    });
    expect(suggestions).toEqual(["npm", "pypi", "huggingface", "brew"]);
  });

  it("forwards enabled messaging channels into tier suggestions", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: ["telegram"],
      knownPresetNames: known,
    });
    expect(suggestions).toContain("telegram");
    expect(suggestions).toContain("npm");
    expect(suggestions).toContain("brave");

    const multi = computeSetupPresetSuggestions("balanced", {
      enabledChannels: ["discord", "slack"],
      knownPresetNames: known,
    });
    expect(multi).toContain("discord");
    expect(multi).toContain("slack");
  });

  it("does not duplicate channels already present in the tier", () => {
    const suggestions = computeSetupPresetSuggestions("open", {
      enabledChannels: ["telegram", "slack"],
      knownPresetNames: known,
    });
    expect(suggestions.filter((name: string) => name === "telegram")).toHaveLength(1);
    expect(suggestions.filter((name: string) => name === "slack")).toHaveLength(1);
  });

  it("drops channel names that are not known presets", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: ["telegram", "not-a-real-preset"],
      knownPresetNames: known,
    });
    expect(suggestions).toContain("telegram");
    expect(suggestions).not.toContain("not-a-real-preset");
  });

  it("handles Brave web search config with support checks", () => {
    expect(
      computeSetupPresetSuggestions("restricted", {
        webSearchConfig: { provider: "brave" },
        knownPresetNames: known,
      }),
    ).toContain("brave");
    expect(
      computeSetupPresetSuggestions("restricted", {
        webSearchConfig: { provider: "brave" },
        knownPresetNames: known,
        webSearchSupported: false,
      }),
    ).not.toContain("brave");
  });

  it("adds local-inference for local providers", () => {
    expect(
      computeSetupPresetSuggestions("balanced", {
        provider: "ollama-local",
        knownPresetNames: known,
      }),
    ).toContain("local-inference");
  });

  it("ignores enabledChannels when null", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: null,
      knownPresetNames: known,
    });
    expect(suggestions).not.toContain("telegram");
    expect(suggestions).not.toContain("slack");
    expect(suggestions).not.toContain("discord");
  });
});
