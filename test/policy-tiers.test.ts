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
import policies from "../dist/lib/policies";
import tiers from "../dist/lib/tiers";

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
  const tier = tiers.getTier(name);
  expect(tier).not.toBeNull();
  const tierObject: TierShape | null = typeof tier === "object" && tier !== null ? tier : null;
  if (!isTier(tierObject)) {
    throw new Error(`Expected tier '${name}' to be present`);
  }
  return tierObject;
}

describe("tiers", () => {
  describe("listTiers", () => {
    it("returns exactly 3 tiers", () => {
      expect(tiers.listTiers()).toHaveLength(3);
    });

    it("tiers are ordered restricted → balanced → open", () => {
      const names = tiers.listTiers().map((tier: Tier) => tier.name);
      expect(names).toEqual(["restricted", "balanced", "open"]);
    });

    it("each tier has name, label, description, and presets array", () => {
      for (const tier of tiers.listTiers()) {
        expect(typeof tier.name).toBe("string");
        expect(typeof tier.label).toBe("string");
        expect(typeof tier.description).toBe("string");
        expect(Array.isArray(tier.presets)).toBe(true);
      }
    });

    it("labels are human-readable capitalised strings", () => {
      const labels = tiers.listTiers().map((tier: Tier) => tier.label);
      expect(labels).toEqual(["Restricted", "Balanced", "Open"]);
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

    it("returns null for an unknown tier", () => {
      expect(tiers.getTier("nonexistent")).toBeNull();
    });
  });

  describe("tier: restricted", () => {
    it("has no presets — base sandbox policy only", () => {
      expect(mustGetTier("restricted").presets).toHaveLength(0);
    });
  });

  describe("tier: balanced", () => {
    it("includes npm, pypi, huggingface, brew, and brave", () => {
      const names = mustGetTier("balanced").presets.map((preset: TierPreset) => preset.name);
      expect(names).toContain("npm");
      expect(names).toContain("pypi");
      expect(names).toContain("huggingface");
      expect(names).toContain("brew");
      expect(names).toContain("brave");
    });

    it("has at least 5 presets", () => {
      expect(mustGetTier("balanced").presets.length).toBeGreaterThanOrEqual(5);
    });

    it("all balanced presets are read-write", () => {
      for (const preset of mustGetTier("balanced").presets) {
        expect(preset.access).toBe("read-write");
      }
    });

    it("does not include messaging presets (slack, discord, telegram)", () => {
      const names = mustGetTier("balanced").presets.map((preset: TierPreset) => preset.name);
      expect(names).not.toContain("slack");
      expect(names).not.toContain("discord");
      expect(names).not.toContain("telegram");
    });
  });

  describe("tier: open", () => {
    it("has more presets than balanced", () => {
      const balancedCount = mustGetTier("balanced").presets.length;
      const openCount = mustGetTier("open").presets.length;
      expect(openCount).toBeGreaterThan(balancedCount);
    });

    it("all open presets are read-write", () => {
      for (const preset of mustGetTier("open").presets) {
        expect(preset.access).toBe("read-write");
      }
    });

    it("includes messaging presets (slack, discord, telegram)", () => {
      const names = mustGetTier("open").presets.map((preset: TierPreset) => preset.name);
      expect(names).toContain("slack");
      expect(names).toContain("discord");
      expect(names).toContain("telegram");
    });

    it("includes productivity presets (jira, outlook)", () => {
      const names = mustGetTier("open").presets.map((preset: TierPreset) => preset.name);
      expect(names).toContain("jira");
      expect(names).toContain("outlook");
    });

    it("open tier contains all balanced presets by name", () => {
      const balancedNames = new Set(
        mustGetTier("balanced").presets.map((preset: TierPreset) => preset.name),
      );
      const openNames = new Set(
        mustGetTier("open").presets.map((preset: TierPreset) => preset.name),
      );
      for (const name of balancedNames) {
        expect(openNames.has(name)).toBe(true);
      }
    });
  });

  describe("resolveTierPresets", () => {
    it("returns default presets for balanced with no overrides", () => {
      const resolved: TierPreset[] = tiers.resolveTierPresets("balanced");
      expect(resolved.length).toBeGreaterThanOrEqual(5);
      for (const preset of resolved) {
        expect(preset.access).toBe("read-write");
      }
    });

    it("applies access override for a specific preset", () => {
      const resolved: TierPreset[] = tiers.resolveTierPresets("balanced", {
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
      const resolved: TierPreset[] = tiers.resolveTierPresets("balanced", {
        selected: ["npm", "pypi"],
      });
      expect(resolved).toHaveLength(2);
      const names = resolved.map((preset: TierPreset) => preset.name);
      expect(names).toContain("npm");
      expect(names).toContain("pypi");
    });

    it("applies overrides and selection together", () => {
      const resolved: TierPreset[] = tiers.resolveTierPresets("balanced", {
        overrides: { npm: "read" },
        selected: ["npm"],
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe("npm");
      expect(resolved[0].access).toBe("read");
    });

    it("returns empty array for restricted tier", () => {
      expect(tiers.resolveTierPresets("restricted")).toHaveLength(0);
    });

    it("throws for an unknown tier", () => {
      expect(() => tiers.resolveTierPresets("phantom")).toThrow("Unknown tier");
    });

    it("selected list with no matches returns empty array", () => {
      const resolved: TierPreset[] = tiers.resolveTierPresets("balanced", {
        selected: ["nonexistent-preset"],
      });
      expect(resolved).toHaveLength(0);
    });

    it("null selected is treated as no filter (all presets returned)", () => {
      const all: TierPreset[] = tiers.resolveTierPresets("balanced");
      const withNull: TierPreset[] = tiers.resolveTierPresets("balanced", { selected: null });
      expect(withNull).toHaveLength(all.length);
    });

    it("open tier resolve returns all open presets", () => {
      const openTier = mustGetTier("open");
      const resolved: TierPreset[] = tiers.resolveTierPresets("open");
      expect(resolved).toHaveLength(openTier.presets.length);
    });

    it("each resolved preset has name and access fields", () => {
      for (const tier of tiers.listTiers()) {
        for (const preset of tiers.resolveTierPresets(tier.name)) {
          expect(typeof preset.name).toBe("string");
          expect(typeof preset.access).toBe("string");
          expect(preset.access.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("integration: all tier presets exist on disk", () => {
    it("every preset referenced in tiers.yaml exists as a preset file", () => {
      const available = new Set(policies.listPresets().map((preset: Preset) => preset.name));
      for (const tier of tiers.listTiers()) {
        for (const preset of tier.presets) {
          expect(
            available.has(preset.name),
            `Preset '${preset.name}' in tier '${tier.name}' not found on disk`,
          ).toBe(true);
        }
      }
    });
  });
});
