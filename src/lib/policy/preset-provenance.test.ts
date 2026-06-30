// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

interface FakeTierPreset {
  name: string;
  access: string;
}
interface FakeTier {
  name: string;
  label: string;
  description: string;
  presets: FakeTierPreset[];
}

const { TIER_FIXTURES } = vi.hoisted(() => {
  const fixtures: Record<string, FakeTier> = {
    balanced: {
      name: "balanced",
      label: "Balanced",
      description: "balanced fixture",
      presets: [
        { name: "npm", access: "read-write" },
        { name: "pypi", access: "read-write" },
        { name: "huggingface", access: "read-write" },
        { name: "brew", access: "read-write" },
        { name: "brave", access: "read-write" },
      ],
    },
    open: {
      name: "open",
      label: "Open",
      description: "open fixture",
      presets: [
        { name: "npm", access: "read-write" },
        { name: "slack", access: "read-write" },
        { name: "weather", access: "read" },
      ],
    },
  };
  return { TIER_FIXTURES: fixtures };
});

vi.mock("./tiers", () => ({
  getTier: (name: string): FakeTier | undefined => TIER_FIXTURES[name],
}));

import { classifyPresetProvenance, formatPresetProvenanceTag } from "./preset-provenance";

describe("classifyPresetProvenance", () => {
  it("classifies tier-default presets as tier-sourced for that tier", () => {
    expect(classifyPresetProvenance("npm", { tierName: "balanced" })).toEqual({
      source: "tier",
      tier: "balanced",
    });
    expect(classifyPresetProvenance("brave", { tierName: "balanced" })).toEqual({
      source: "tier",
      tier: "balanced",
    });
  });

  it("classifies tier-default presets under the Open tier too", () => {
    expect(classifyPresetProvenance("slack", { tierName: "open" })).toEqual({
      source: "tier",
      tier: "open",
    });
  });

  it("classifies openclaw-pricing as agent-sourced for openclaw sandboxes", () => {
    expect(
      classifyPresetProvenance("openclaw-pricing", {
        tierName: "balanced",
        agentName: "openclaw",
      }),
    ).toEqual({ source: "agent", agent: "openclaw" });
  });

  it("classifies openclaw-diagnostics-otel-local as openclaw-agent-sourced on openclaw sandboxes", () => {
    expect(
      classifyPresetProvenance("openclaw-diagnostics-otel-local", {
        tierName: "balanced",
        agentName: "openclaw",
      }),
    ).toEqual({ source: "agent", agent: "openclaw" });
  });

  it("classifies nous-* gateway presets as hermes-agent-sourced on hermes sandboxes", () => {
    expect(classifyPresetProvenance("nous-web", { tierName: "open", agentName: "hermes" })).toEqual(
      {
        source: "agent",
        agent: "hermes",
      },
    );
    expect(classifyPresetProvenance("nous-code", { agentName: "hermes" })).toEqual({
      source: "agent",
      agent: "hermes",
    });
  });

  it("does not label openclaw-only presets as agent-sourced on hermes sandboxes", () => {
    expect(
      classifyPresetProvenance("openclaw-pricing", {
        tierName: "open",
        agentName: "hermes",
      }),
    ).toEqual({ source: "user" });
  });

  it("does not label hermes-only presets as agent-sourced on openclaw sandboxes", () => {
    expect(
      classifyPresetProvenance("nous-web", {
        tierName: "balanced",
        agentName: "openclaw",
      }),
    ).toEqual({ source: "user" });
  });

  it("does not label agent-only presets without a known agentName", () => {
    expect(classifyPresetProvenance("openclaw-pricing", {})).toEqual({ source: "user" });
    expect(classifyPresetProvenance("nous-web", { agentName: null })).toEqual({
      source: "user",
    });
  });

  it("falls back to user-source for non-tier, non-agent presets", () => {
    expect(classifyPresetProvenance("custom-private", { tierName: "balanced" })).toEqual({
      source: "user",
    });
  });

  it("treats missing tier context as no tier match", () => {
    expect(classifyPresetProvenance("npm", {})).toEqual({ source: "user" });
    expect(classifyPresetProvenance("npm", { tierName: null })).toEqual({
      source: "user",
    });
  });

  it("normalises preset, tier, and agent casing", () => {
    expect(
      classifyPresetProvenance("OPENCLAW-PRICING", {
        tierName: " BALANCED ",
        agentName: "OpenClaw",
      }),
    ).toEqual({
      source: "agent",
      agent: "openclaw",
    });
    expect(classifyPresetProvenance("NPM", { tierName: " BALANCED " })).toEqual({
      source: "tier",
      tier: "balanced",
    });
  });
});

describe("formatPresetProvenanceTag", () => {
  it("renders the tier source as 'from <tier> tier'", () => {
    expect(formatPresetProvenanceTag({ source: "tier", tier: "balanced" })).toBe(
      "from balanced tier",
    );
  });

  it("renders the agent source as 'from <agent> agent'", () => {
    expect(formatPresetProvenanceTag({ source: "agent", agent: "openclaw" })).toBe(
      "from openclaw agent",
    );
    expect(formatPresetProvenanceTag({ source: "agent", agent: "hermes" })).toBe(
      "from hermes agent",
    );
  });

  it("renders the user source as 'user-added'", () => {
    expect(formatPresetProvenanceTag({ source: "user" })).toBe("user-added");
  });
});
