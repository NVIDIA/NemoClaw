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
      agent?: string | null;
      webSearchConfig?: { fetchEnabled?: boolean; provider?: string | null } | null;
      webSearchSupported?: boolean | null;
      env?: NodeJS.ProcessEnv;
    },
  ) => string[];
  filterSetupPolicyPresets: <T extends { name: string }>(
    presets: T[],
    options?: { webSearchSupported?: boolean | null },
  ) => T[];
  getSuggestedPolicyPresets: (options?: {
    enabledChannels?: string[] | null;
    provider?: string | null;
    agent?: string | null;
    env?: NodeJS.ProcessEnv;
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
      expect(getSuggestedPolicyPresets({ enabledChannels: [] })).toEqual([
        "pypi",
        "npm",
        "openclaw-pricing",
      ]);
      expect(getSuggestedPolicyPresets({ enabledChannels: ["telegram"] })).toEqual([
        "pypi",
        "npm",
        "openclaw-pricing",
        "telegram",
      ]);
      expect(getSuggestedPolicyPresets({ enabledChannels: ["discord", "slack"] })).toEqual([
        "pypi",
        "npm",
        "openclaw-pricing",
        "slack",
        "discord",
      ]);
      expect(getSuggestedPolicyPresets({ enabledChannels: ["whatsapp"] })).toEqual([
        "pypi",
        "npm",
        "openclaw-pricing",
        "whatsapp",
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

  it("never auto-detects WhatsApp because the channel has no host env key", () => {
    const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      expect(getSuggestedPolicyPresets()).not.toContain("whatsapp");
      expect(getSuggestedPolicyPresets({ provider: null })).not.toContain("whatsapp");
    } finally {
      if (originalTelegramBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalTelegramBotToken;
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

  it("suggests openclaw-pricing preset only for the openclaw agent", () => {
    expect(getSuggestedPolicyPresets({ agent: "openclaw" })).toContain("openclaw-pricing");
    expect(getSuggestedPolicyPresets({ agent: null })).toContain("openclaw-pricing");
    expect(getSuggestedPolicyPresets({})).toContain("openclaw-pricing");
    expect(getSuggestedPolicyPresets({ agent: "hermes" })).not.toContain("openclaw-pricing");
  });

  it("suggests local OTEL policy only when OpenClaw OTEL is enabled", () => {
    const original = process.env.NEMOCLAW_OPENCLAW_OTEL;
    const originalEndpoint = process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
    try {
      delete process.env.NEMOCLAW_OPENCLAW_OTEL;
      delete process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
      expect(getSuggestedPolicyPresets({ agent: "openclaw" })).not.toContain(
        "openclaw-diagnostics-otel-local",
      );

      process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
      expect(getSuggestedPolicyPresets({ agent: "openclaw" })).toContain(
        "openclaw-diagnostics-otel-local",
      );
      expect(getSuggestedPolicyPresets({ agent: "hermes" })).not.toContain(
        "openclaw-diagnostics-otel-local",
      );

      process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = "https://otel.example.com:4318";
      expect(getSuggestedPolicyPresets({ agent: "openclaw" })).not.toContain(
        "openclaw-diagnostics-otel-local",
      );
    } finally {
      if (original === undefined) delete process.env.NEMOCLAW_OPENCLAW_OTEL;
      else process.env.NEMOCLAW_OPENCLAW_OTEL = original;
      if (originalEndpoint === undefined) delete process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
      else process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = originalEndpoint;
    }
  });

  it("adds openclaw-pricing to tier suggestions when agent is openclaw", () => {
    const knownWithPricing = [...known, "openclaw-pricing"];
    const openclawSuggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithPricing,
      agent: "openclaw",
    });
    expect(openclawSuggestions).toContain("openclaw-pricing");

    const hermesSuggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithPricing,
      agent: "hermes",
    });
    expect(hermesSuggestions).not.toContain("openclaw-pricing");

    // Default/blank agents are OpenClaw in the lower-level helpers too.
    const nullAgentSuggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithPricing,
      agent: null,
    });
    expect(nullAgentSuggestions).toContain("openclaw-pricing");

    const omittedAgentSuggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithPricing,
    });
    expect(omittedAgentSuggestions).toContain("openclaw-pricing");

    const blankAgentSuggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithPricing,
      agent: " ",
    });
    expect(blankAgentSuggestions).toContain("openclaw-pricing");
  });

  it("adds local OTEL policy to tier suggestions only when OpenClaw OTEL is enabled", () => {
    const knownWithOtel = [...known, "openclaw-pricing", "openclaw-diagnostics-otel-local"];
    const openclawSuggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithOtel,
      agent: "openclaw",
      env: { NEMOCLAW_OPENCLAW_OTEL: "1" },
    });
    expect(openclawSuggestions).toContain("openclaw-diagnostics-otel-local");

    const remoteSuggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithOtel,
      agent: "openclaw",
      env: {
        NEMOCLAW_OPENCLAW_OTEL: "1",
        NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "https://otel.example.com:4318",
      },
    });
    expect(remoteSuggestions).not.toContain("openclaw-diagnostics-otel-local");

    const disabledSuggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithOtel,
      agent: "openclaw",
      env: { NEMOCLAW_OPENCLAW_OTEL: "0" },
    });
    expect(disabledSuggestions).not.toContain("openclaw-diagnostics-otel-local");
  });

  it("returns balanced tier defaults without messaging presets when no channels enabled", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: known,
    });
    expect(suggestions).toEqual(["npm", "pypi", "huggingface", "brew"]);
  });

  it("adds Brave to balanced tier defaults only when web search is configured", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: known,
      webSearchConfig: { fetchEnabled: true },
      webSearchSupported: true,
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
    expect(suggestions).not.toContain("brave");

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
