// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the tier-based policy selector.
//
// These tests define the contract for the tier system. They cover:
//   - Tier loading and structure
//   - Tier content (which presets belong where)
//   - Access level defaults and overrides
//   - Preset deselection within a tier
//   - Integration with the existing policies module

import { describe, expect, it } from "vitest";
import * as policies from "../../../src/lib/policy";
import { getTier, listTiers, resolveTierPresets } from "../../../src/lib/policy/tiers";

interface TierPreset {
  name: string;
  access: string;
}

interface Tier {
  name: string;
  label: string;
  description: string;
  presets: TierPreset[];
}

interface Preset {
  name: string;
}

type TierShape = {
  name?: string;
  label?: string;
  description?: string;
  presets?: TierPreset[];
};

function requireTierPreset(value: TierPreset | undefined, name: string): TierPreset {
  expect(value).toBeDefined();
  if (!value) {
    throw new Error(`Expected preset '${name}' to be present`);
  }
  return value;
}

function isTier(value: TierShape | null): value is Tier {
  return (
    value !== null &&
    typeof value.name === "string" &&
    typeof value.label === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.presets)
  );
}

function mustGetTier(name: string): Tier {
  const tier = getTier(name);
  expect(tier).not.toBeNull();
  const tierObject: TierShape | null = typeof tier === "object" && tier !== null ? tier : null;
  if (!isTier(tierObject)) {
    throw new Error(`Expected tier '${name}' to be present`);
  }
  return tierObject;
}

describe("tiers", () => {
  describe("listTiers", () => {
    it("returns exactly 4 tiers", () => {
      expect(listTiers()).toHaveLength(4);
    });

    it("orders tiers as restricted, balanced, open, then personal", () => {
      const names = listTiers().map((tier: Tier) => tier.name);
      expect(names).toEqual(["restricted", "balanced", "open", "personal"]);
    });

    it.each(listTiers())("$name has the required tier fields", (tier) => {
      expect(typeof tier.name).toBe("string");
      expect(typeof tier.label).toBe("string");
      expect(typeof tier.description).toBe("string");
      expect(Array.isArray(tier.presets)).toBe(true);
    });

    it("labels are human-readable capitalised strings", () => {
      const labels = listTiers().map((tier: Tier) => tier.label);
      expect(labels).toEqual(["Restricted", "Balanced", "Open", "Personal"]);
    });
  });

  describe("getTier", () => {
    it("returns the restricted tier", () => {
      const tier = mustGetTier("restricted");
      expect(tier.name).toBe("restricted");
    });

    it("returns the balanced tier", () => {
      const tier = mustGetTier("balanced");
      expect(tier.name).toBe("balanced");
    });

    it("returns the open tier", () => {
      const tier = mustGetTier("open");
      expect(tier.name).toBe("open");
    });

    it("returns the personal tier", () => {
      const tier = mustGetTier("personal");
      expect(tier.name).toBe("personal");
    });

    it("returns null for an unknown tier", () => {
      expect(getTier("nonexistent")).toBeNull();
    });
  });

  describe("tier: restricted", () => {
    it("has no presets — base sandbox policy only", () => {
      expect(mustGetTier("restricted").presets).toHaveLength(0);
    });
  });

  describe("tier: balanced", () => {
    it("includes exactly npm, pypi, huggingface, brew, and brave", () => {
      const names = mustGetTier("balanced").presets.map((preset: TierPreset) => preset.name);
      expect(names).toEqual(
        expect.arrayContaining(["npm", "pypi", "huggingface", "brew", "brave"]),
      );
      expect(names).toHaveLength(5);
    });

    it("does not include the weather preset", () => {
      const names = mustGetTier("balanced").presets.map((preset: TierPreset) => preset.name);
      expect(names).not.toContain("weather");
    });

    it.each(["npm", "pypi", "huggingface", "brew", "brave"])(
      "keeps the %s preset read-write",
      (name) => {
        const accessByName = new Map(
          mustGetTier("balanced").presets.map((preset: TierPreset) => [preset.name, preset.access]),
        );
        expect(accessByName.get(name)).toBe("read-write");
      },
    );

    it("does not include messaging presets (slack, discord, telegram, wechat, whatsapp)", () => {
      const names = mustGetTier("balanced").presets.map((preset: TierPreset) => preset.name);
      expect(names).not.toContain("slack");
      expect(names).not.toContain("discord");
      expect(names).not.toContain("telegram");
      expect(names).not.toContain("wechat");
      expect(names).not.toContain("whatsapp");
    });
  });

  describe("tier: open", () => {
    it("has more presets than balanced", () => {
      const balancedCount = mustGetTier("balanced").presets.length;
      const openCount = mustGetTier("open").presets.length;
      expect(openCount).toBeGreaterThan(balancedCount);
    });

    it.each([
      ["npm", "read-write"],
      ["pypi", "read-write"],
      ["huggingface", "read-write"],
      ["brew", "read-write"],
      ["brave", "read-write"],
      ["slack", "read-write"],
      ["discord", "read-write"],
      ["telegram", "read-write"],
      ["wechat", "read-write"],
      ["whatsapp", "read-write"],
      ["jira", "read-write"],
      ["outlook", "read-write"],
      ["weather", "read"],
      ["public-reference", "read"],
    ])("gives the %s preset %s access", (name, access) => {
      const accessByName = new Map(
        mustGetTier("open").presets.map((preset: TierPreset) => [preset.name, preset.access]),
      );
      expect(accessByName.get(name)).toBe(access);
    });

    it("includes messaging presets (slack, discord, telegram, wechat, whatsapp)", () => {
      const names = mustGetTier("open").presets.map((preset: TierPreset) => preset.name);
      expect(names).toContain("slack");
      expect(names).toContain("discord");
      expect(names).toContain("telegram");
      expect(names).toContain("wechat");
      expect(names).toContain("whatsapp");
    });

    it("includes productivity presets (jira, outlook)", () => {
      const names = mustGetTier("open").presets.map((preset: TierPreset) => preset.name);
      expect(names).toContain("jira");
      expect(names).toContain("outlook");
    });

    it("includes curated read-only public data presets", () => {
      const names = mustGetTier("open").presets.map((preset: TierPreset) => preset.name);
      expect(names).toContain("weather");
      expect(names).toContain("public-reference");
    });

    it.each(mustGetTier("balanced").presets)("includes the balanced $name preset", ({ name }) => {
      const openNames = new Set(
        mustGetTier("open").presets.map((preset: TierPreset) => preset.name),
      );
      expect(openNames.has(name)).toBe(true);
    });
  });

  describe("tier: personal", () => {
    it("uses one broad web authority instead of overlapping endpoint presets (#9206)", () => {
      expect(mustGetTier("personal").presets).toEqual([
        { name: "personal-open-internet", access: "read-write" },
      ]);
    });

    it("describes the trusted Personal boundary", () => {
      expect(mustGetTier("personal").description).toMatch(
        /every sandbox binary.*public and private.*80 and 443/i,
      );
    });
  });

  describe("resolveTierPresets", () => {
    it.each(["npm", "pypi", "huggingface", "brew", "brave"])(
      "returns the default %s preset for balanced",
      (name) => {
        const resolved: TierPreset[] = resolveTierPresets("balanced");
        expect(resolved.length).toBe(5);
        const accessByName = new Map(resolved.map((preset) => [preset.name, preset.access]));
        expect(accessByName.get(name)).toBe("read-write");
      },
    );

    it("keeps weather out of balanced defaults", () => {
      const accessByName = new Map(
        resolveTierPresets("balanced").map((preset) => [preset.name, preset.access]),
      );
      expect(accessByName.has("weather")).toBe(false);
    });

    it("applies access override for a specific preset", () => {
      const resolved: TierPreset[] = resolveTierPresets("balanced", {
        overrides: { npm: "read" },
      });
      const npm = requireTierPreset(
        resolved.find((preset: TierPreset) => preset.name === "npm"),
        "npm",
      );
      expect(npm.access).toBe("read");
      const pypi = requireTierPreset(
        resolved.find((preset: TierPreset) => preset.name === "pypi"),
        "pypi",
      );
      expect(pypi.access).toBe("read-write");
    });

    it("restricts to selected presets when selected list is provided", () => {
      const resolved: TierPreset[] = resolveTierPresets("balanced", {
        selected: ["npm", "pypi"],
      });
      expect(resolved).toHaveLength(2);
      const names = resolved.map((preset: TierPreset) => preset.name);
      expect(names).toContain("npm");
      expect(names).toContain("pypi");
    });

    it("applies overrides and selection together", () => {
      const resolved: TierPreset[] = resolveTierPresets("balanced", {
        overrides: { npm: "read" },
        selected: ["npm"],
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe("npm");
      expect(resolved[0].access).toBe("read");
    });

    it("returns empty array for restricted tier", () => {
      expect(resolveTierPresets("restricted")).toHaveLength(0);
    });

    it("throws for an unknown tier", () => {
      expect(() => resolveTierPresets("phantom")).toThrow("Unknown tier");
    });

    it("selected list with no matches returns empty array", () => {
      const resolved: TierPreset[] = resolveTierPresets("balanced", {
        selected: ["nonexistent-preset"],
      });
      expect(resolved).toHaveLength(0);
    });

    it("null selected is treated as no filter (all presets returned)", () => {
      const all: TierPreset[] = resolveTierPresets("balanced");
      const withNull: TierPreset[] = resolveTierPresets("balanced", { selected: null });
      expect(withNull).toHaveLength(all.length);
    });

    it("open tier resolve returns all open presets", () => {
      const openTier = mustGetTier("open");
      const resolved: TierPreset[] = resolveTierPresets("open");
      expect(resolved).toHaveLength(openTier.presets.length);
    });

    it.each(
      listTiers().flatMap((tier) =>
        resolveTierPresets(tier.name).map((preset) => ({ preset, tier: tier.name })),
      ),
    )("resolves $preset.name with name and access fields for $tier", ({ preset }) => {
      expect(typeof preset.name).toBe("string");
      expect(typeof preset.access).toBe("string");
      expect(preset.access.length).toBeGreaterThan(0);
    });
  });

  describe("integration: all tier presets exist on disk", () => {
    it.each(listTiers().flatMap((tier) => tier.presets.map((preset) => ({ preset, tier }))))(
      "finds the $preset.name preset referenced by $tier.name on disk",
      ({ preset, tier }) => {
        const available = new Set(policies.listPresets().map((preset: Preset) => preset.name));
        expect(
          available.has(preset.name),
          `Preset '${preset.name}' in tier '${tier.name}' not found on disk`,
        ).toBe(true);
      },
    );
  });
});
