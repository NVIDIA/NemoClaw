// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { filterSetupPolicyPresetsForAgent } from "../src/lib/onboard/agent-policy-presets";
import {
  allMessagingChannelPolicyPresets,
  mergeEnabledMessagingChannelPolicyPresets,
} from "../src/lib/onboard/messaging-policy-presets";

// `../src/lib/onboard` is a CommonJS module (`module.exports = {}`), so it is
// loaded via `require` per the documented CJS exception for the onboard module.
const { computeSetupPresetSuggestions, filterSetupPolicyPresets, getSuggestedPolicyPresets } =
  require("../src/lib/onboard") as {
    computeSetupPresetSuggestions: (
      tierName: string,
      options: {
        enabledChannels?: string[] | null;
        knownPresetNames: string[];
        provider?: string | null;
        agent?: string | null;
        webSearchConfig?: { fetchEnabled?: boolean; provider?: string | null } | null;
        webSearchSupported?: boolean | null;
        hermesToolGateways?: string[] | null;
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
const { mergeRequiredSetupPolicyPresets, suppressedAgentRequiredPresets } =
  require("../src/lib/onboard/policy-selection") as {
    mergeRequiredSetupPolicyPresets: (
      policyPresets: string[],
      options?: {
        enabledChannels?: string[] | null;
        hermesToolGateways?: string[] | null;
        agent?: string | null;
        knownPresetNames?: string[] | Set<string> | null;
        env?: NodeJS.ProcessEnv;
        tierName?: string | null;
      },
    ) => string[];
    suppressedAgentRequiredPresets: (
      tierName: string,
      agent: string | null | undefined,
    ) => string[];
  };
const { agentRequiredPresetAdditions, filterSuppressedAgentRequiredPresets } =
  require("../src/lib/onboard/policy-tier-suppression") as {
    agentRequiredPresetAdditions: (
      agent: string | null | undefined,
      env: NodeJS.ProcessEnv,
    ) => string[];
    filterSuppressedAgentRequiredPresets: (
      presetNames: string[],
      tierName: string | null | undefined,
      agent: string | null | undefined,
    ) => string[];
  };

function setOrUnset(key: string, value: string | undefined): void {
  value === undefined ? delete process.env[key] : (process.env[key] = value);
}

function withOpenclawOtelEnv<T>(value: string | undefined, body: () => T): T {
  const otelKey = "NEMOCLAW_OPENCLAW_OTEL";
  const endpointKey = "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT";
  const originalOtel = process.env[otelKey];
  const originalEndpoint = process.env[endpointKey];
  setOrUnset(otelKey, value);
  delete process.env[endpointKey];
  try {
    return body();
  } finally {
    setOrUnset(otelKey, originalOtel);
    setOrUnset(endpointKey, originalEndpoint);
  }
}

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
    "weather",
    "public-reference",
    "nous-web",
    "nous-image",
    "nous-audio",
    "nous-browser",
    "nous-code",
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
        "discord",
        "slack",
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

  // Cross-verification (#5967): the suggestion path
  // (`computeSetupPresetSuggestions`) and the finalization merge
  // (`mergeEnabledMessagingChannelPolicyPresets`) must contribute the SAME
  // channel egress presets for a given `enabledChannels` set. If they diverged,
  // an operator could be suggested a preset finalization later drops (or finalize
  // one never suggested). Assert both paths yield exactly
  // `allMessagingChannelPolicyPresets` for every channel individually and combined.
  it("suggestion and finalization paths contribute identical channel presets for all channels (#5967)", () => {
    const channels = ["slack", "discord", "telegram", "teams", "whatsapp", "wechat"];
    const knownNames = [...known, "teams", "whatsapp", "wechat"];
    const channelPresetSet = new Set(allMessagingChannelPolicyPresets(channels));
    const channelPresetsFromSuggestions = (enabled: string[]) =>
      computeSetupPresetSuggestions("balanced", {
        enabledChannels: enabled,
        knownPresetNames: knownNames,
      }).filter((name) => channelPresetSet.has(name));

    for (const channel of channels) {
      // Compare set equality (sorted) rather than incidental array order, so a
      // channel later expanding to multiple presets can't fail this guard on a
      // harmless ordering difference between the two internal paths.
      const expected = allMessagingChannelPolicyPresets([channel]).slice().sort();
      // Finalization merge contributes exactly the channel's egress presets...
      expect(
        mergeEnabledMessagingChannelPolicyPresets([], [channel], knownNames).slice().sort(),
      ).toEqual(expected);
      // ...and the suggestion path surfaces the same set.
      expect(channelPresetsFromSuggestions([channel]).slice().sort()).toEqual(expected);
    }

    // All channels enabled together: both paths agree on the full set.
    const expectedAll = allMessagingChannelPolicyPresets(channels).slice().sort();
    expect(
      mergeEnabledMessagingChannelPolicyPresets([], channels, knownNames).slice().sort(),
    ).toEqual(expectedAll);
    expect(channelPresetsFromSuggestions(channels).slice().sort()).toEqual(expectedAll);
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

  it("auto-detects messaging policy presets from secondary channel credentials", () => {
    const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
    const originalSlackAppToken = process.env.SLACK_APP_TOKEN;
    try {
      delete process.env.SLACK_BOT_TOKEN;
      process.env.SLACK_APP_TOKEN = "xapp-secondary";

      expect(getSuggestedPolicyPresets()).toContain("slack");
    } finally {
      if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
      if (originalSlackAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = originalSlackAppToken;
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

  it("balanced OpenClaw with web search returns exactly brave brew huggingface npm openclaw-pricing pypi and excludes weather", () => {
    const knownWithPricing = [...known, "openclaw-pricing"];
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: knownWithPricing,
      agent: "openclaw",
      webSearchConfig: { fetchEnabled: true },
      webSearchSupported: true,
    });
    expect([...suggestions].sort()).toEqual([
      "brave",
      "brew",
      "huggingface",
      "npm",
      "openclaw-pricing",
      "pypi",
    ]);
    expect(suggestions).not.toContain("weather");
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

  it("adds all Hermes Nous tool policy presets for Hermes open tier only", () => {
    const knownWithPricing = [...known, "openclaw-pricing"];
    const hermesOpen = computeSetupPresetSuggestions("open", {
      enabledChannels: [],
      knownPresetNames: knownWithPricing,
      agent: "hermes",
    });
    for (const preset of ["nous-web", "nous-image", "nous-audio", "nous-browser", "nous-code"]) {
      expect(hermesOpen).toContain(preset);
    }
    expect(hermesOpen).toContain("weather");
    expect(hermesOpen).toContain("public-reference");
    expect(hermesOpen).not.toContain("openclaw-pricing");

    const openclawOpen = computeSetupPresetSuggestions("open", {
      enabledChannels: [],
      knownPresetNames: knownWithPricing,
      agent: "openclaw",
    });
    for (const preset of ["nous-web", "nous-image", "nous-audio", "nous-browser", "nous-code"]) {
      expect(openclawOpen).not.toContain(preset);
    }
    expect(openclawOpen).toContain("openclaw-pricing");
    expect(openclawOpen).toContain("weather");
    expect(openclawOpen).toContain("public-reference");
  });

  it("keeps agent-specific policy presets out of the opposite agent selector", () => {
    const allPresets = [
      { name: "weather" },
      { name: "openclaw-pricing" },
      { name: "openclaw-diagnostics-otel-local" },
      { name: "nous-web" },
      { name: "nous-image" },
    ];

    expect(filterSetupPolicyPresetsForAgent(allPresets, "hermes").map((p) => p.name)).toEqual([
      "weather",
      "nous-web",
      "nous-image",
    ]);
    expect(filterSetupPolicyPresetsForAgent(allPresets, "openclaw").map((p) => p.name)).toEqual([
      "weather",
      "openclaw-pricing",
      "openclaw-diagnostics-otel-local",
    ]);
  });

  it("does not add explicitly requested Hermes Nous presets to OpenClaw suggestions", () => {
    const suggestions = computeSetupPresetSuggestions("balanced", {
      enabledChannels: [],
      knownPresetNames: known,
      agent: "openclaw",
      hermesToolGateways: ["nous-web", "nous-code"],
    });
    expect(suggestions).not.toContain("nous-web");
    expect(suggestions).not.toContain("nous-code");
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

  describe("restricted tier suppresses agent-required preset additions", () => {
    const knownWithPricing = [...known, "openclaw-pricing", "openclaw-diagnostics-otel-local"];

    it("does not auto-add openclaw-pricing for an OpenClaw sandbox on the restricted tier", () => {
      const suggestions = computeSetupPresetSuggestions("restricted", {
        agent: "openclaw",
        knownPresetNames: knownWithPricing,
      });
      expect(suggestions).toEqual([]);
    });

    it("still auto-adds openclaw-pricing for an OpenClaw sandbox on the balanced tier", () => {
      const suggestions = computeSetupPresetSuggestions("balanced", {
        agent: "openclaw",
        knownPresetNames: knownWithPricing,
      });
      expect(suggestions).toContain("openclaw-pricing");
    });

    it("does not auto-add the local OTEL preset on the restricted tier even when OTEL is enabled", () => {
      withOpenclawOtelEnv("1", () => {
        const suggestions = computeSetupPresetSuggestions("restricted", {
          agent: "openclaw",
          knownPresetNames: knownWithPricing,
          env: process.env,
        });
        expect(suggestions).not.toContain("openclaw-diagnostics-otel-local");
      });
    });

    it("treats a null agent as OpenClaw and still suppresses openclaw-pricing on restricted", () => {
      const suggestions = computeSetupPresetSuggestions("restricted", {
        agent: null,
        knownPresetNames: knownWithPricing,
      });
      expect(suggestions).not.toContain("openclaw-pricing");
    });

    it("leaves Hermes sandboxes on restricted unchanged (no OpenClaw-only suppression needed)", () => {
      const suggestions = computeSetupPresetSuggestions("restricted", {
        agent: "hermes",
        knownPresetNames: knownWithPricing,
      });
      expect(suggestions).toEqual([]);
    });
  });

  describe("suppressedAgentRequiredPresets", () => {
    it("reports openclaw-pricing and openclaw-diagnostics-otel-local as suppressed on restricted + openclaw", () => {
      expect(suppressedAgentRequiredPresets("restricted", "openclaw")).toEqual([
        "openclaw-pricing",
        "openclaw-diagnostics-otel-local",
      ]);
    });

    it("reports the same suppression list when OTEL is currently enabled", () => {
      withOpenclawOtelEnv("1", () => {
        expect(suppressedAgentRequiredPresets("restricted", "openclaw")).toEqual([
          "openclaw-pricing",
          "openclaw-diagnostics-otel-local",
        ]);
      });
    });

    it("still reports openclaw-diagnostics-otel-local when OTEL is currently disabled", () => {
      withOpenclawOtelEnv(undefined, () => {
        expect(suppressedAgentRequiredPresets("restricted", "openclaw")).toContain(
          "openclaw-diagnostics-otel-local",
        );
      });
      withOpenclawOtelEnv("0", () => {
        expect(suppressedAgentRequiredPresets("restricted", "openclaw")).toContain(
          "openclaw-diagnostics-otel-local",
        );
      });
    });

    it("returns no suppressed presets for balanced or open tiers", () => {
      expect(suppressedAgentRequiredPresets("balanced", "openclaw")).toEqual([]);
      expect(suppressedAgentRequiredPresets("open", "openclaw")).toEqual([]);
    });

    it("returns no suppressed presets for non-OpenClaw agents on restricted", () => {
      expect(suppressedAgentRequiredPresets("restricted", "hermes")).toEqual([]);
    });

    it("treats a null agent on restricted as OpenClaw and reports the full suppression list", () => {
      expect(suppressedAgentRequiredPresets("restricted", null)).toEqual([
        "openclaw-pricing",
        "openclaw-diagnostics-otel-local",
      ]);
    });
  });

  describe("filterSuppressedAgentRequiredPresets (interactive preservation safeguard)", () => {
    it("removes openclaw-pricing and openclaw-diagnostics-otel-local from a restricted preset list", () => {
      expect(
        filterSuppressedAgentRequiredPresets(
          ["npm", "openclaw-pricing", "openclaw-diagnostics-otel-local", "pypi"],
          "restricted",
          "openclaw",
        ),
      ).toEqual(["npm", "pypi"]);
    });

    it("returns the input unchanged for balanced and open tiers", () => {
      expect(
        filterSuppressedAgentRequiredPresets(["openclaw-pricing", "npm"], "balanced", "openclaw"),
      ).toEqual(["openclaw-pricing", "npm"]);
      expect(
        filterSuppressedAgentRequiredPresets(["openclaw-pricing", "npm"], "open", "openclaw"),
      ).toEqual(["openclaw-pricing", "npm"]);
    });

    it("returns the input unchanged when tierName is null or undefined", () => {
      expect(
        filterSuppressedAgentRequiredPresets(["openclaw-pricing", "npm"], null, "openclaw"),
      ).toEqual(["openclaw-pricing", "npm"]);
      expect(
        filterSuppressedAgentRequiredPresets(["openclaw-pricing", "npm"], undefined, "openclaw"),
      ).toEqual(["openclaw-pricing", "npm"]);
    });

    it("does not suppress for non-OpenClaw agents on restricted", () => {
      expect(
        filterSuppressedAgentRequiredPresets(
          ["openclaw-pricing", "hermes-tool"],
          "restricted",
          "hermes",
        ),
      ).toEqual(["openclaw-pricing", "hermes-tool"]);
    });
  });

  describe("mergeRequiredSetupPolicyPresets tier plumbing", () => {
    it("suppresses openclaw-pricing only when tierName is restricted", () => {
      expect(
        mergeRequiredSetupPolicyPresets(["npm", "openclaw-pricing"], {
          agent: "openclaw",
          tierName: "restricted",
        }),
      ).toEqual(["npm"]);
      expect(
        mergeRequiredSetupPolicyPresets(["npm", "openclaw-pricing"], {
          agent: "openclaw",
          tierName: "balanced",
        }),
      ).toEqual(["npm", "openclaw-pricing"]);
      expect(
        mergeRequiredSetupPolicyPresets(["npm", "openclaw-pricing"], {
          agent: "openclaw",
          tierName: "open",
        }),
      ).toEqual(["npm", "openclaw-pricing"]);
    });

    it("returns the input unchanged when tierName is omitted (covers the fresh-onboard call site that passes a freshly-selected tierName and the resume call site that passes the recorded tierName — passing null means no tier filter applies)", () => {
      expect(
        mergeRequiredSetupPolicyPresets(["npm", "openclaw-pricing"], { agent: "openclaw" }),
      ).toEqual(["npm", "openclaw-pricing"]);
      expect(
        mergeRequiredSetupPolicyPresets(["npm", "openclaw-pricing"], {
          agent: "openclaw",
          tierName: null,
        }),
      ).toEqual(["npm", "openclaw-pricing"]);
    });

    it("preserves balanced presets when the originally recorded tier was restricted (tier-switch upgrade path)", () => {
      // Caller would pass `tierName: <fresh selection>` for fresh onboarding
      // and `tierName: <recordedTierName>` on resume. Either way, the function
      // applies suppression based on the tier *passed in* — so a tier upgrade
      // from restricted → balanced never re-suppresses the balanced presets.
      const balancedPresets = ["npm", "pypi", "huggingface"];
      expect(
        mergeRequiredSetupPolicyPresets(balancedPresets, {
          agent: "openclaw",
          tierName: "balanced",
        }),
      ).toEqual(balancedPresets);
    });
  });

  describe("restricted suppression list ⊇ env-gated additions (drift invariant)", () => {
    // The restricted suppression list is hardcoded so live cleanup catches
    // presets applied by a prior process with a different env. The env-gated
    // addition list (`agentRequiredPresetAdditions`) is what actually gets
    // added during fresh onboarding. The two can drift if a new OpenClaw
    // agent-required preset is added to the addition path without also being
    // added to the suppression set — leaving stale presets uncleaned on
    // restricted re-onboarding. Lock the invariant: every preset the env-gated
    // additions can produce for OpenClaw must also appear in the restricted
    // suppression list.
    function unionAdditionsAcrossOtelStates(): Set<string> {
      const otelKey = "NEMOCLAW_OPENCLAW_OTEL";
      const endpointKey = "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT";
      const original = { otel: process.env[otelKey], endpoint: process.env[endpointKey] };
      const union = new Set<string>();
      try {
        delete process.env[otelKey];
        delete process.env[endpointKey];
        for (const name of agentRequiredPresetAdditions("openclaw", process.env)) union.add(name);
        process.env[otelKey] = "1";
        delete process.env[endpointKey];
        for (const name of agentRequiredPresetAdditions("openclaw", process.env)) union.add(name);
        process.env[endpointKey] = "https://otel.example.com:4318";
        for (const name of agentRequiredPresetAdditions("openclaw", process.env)) union.add(name);
      } finally {
        setOrUnset(otelKey, original.otel);
        setOrUnset(endpointKey, original.endpoint);
      }
      return union;
    }

    it("includes every env-gated OpenClaw agent-required preset in the restricted suppression list", () => {
      const additionsUnion = unionAdditionsAcrossOtelStates();
      const restrictedSet = new Set(suppressedAgentRequiredPresets("restricted", "openclaw"));
      for (const preset of additionsUnion) {
        expect(
          restrictedSet.has(preset),
          `addition '${preset}' missing from restricted suppression list`,
        ).toBe(true);
      }
    });
  });
});
