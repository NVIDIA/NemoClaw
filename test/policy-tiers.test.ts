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

import { describe, it, expect } from "vitest";
import tiers from "../dist/lib/tiers";
import policies from "../dist/lib/policies";

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

describe("tiers", () => {
  describe("listTiers", () => {
    it("returns exactly 3 tiers", () => {
      expect(tiers.listTiers()).toHaveLength(3);
    });

    it("tiers are ordered restricted → balanced → open", () => {
      const names = tiers.listTiers().map((t: Tier) => t.name);
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
      const labels = tiers.listTiers().map((t: Tier) => t.label);
      expect(labels).toEqual(["Restricted", "Balanced", "Open"]);
    });
  });

  describe("getTier", () => {
    it("returns the restricted tier", () => {
      const t = tiers.getTier("restricted");
      expect(t).not.toBeNull();
      expect(t.name).toBe("restricted");
    });

    it("returns the balanced tier", () => {
      const t = tiers.getTier("balanced");
      expect(t).not.toBeNull();
      expect(t.name).toBe("balanced");
    });

    it("returns the open tier", () => {
      const t = tiers.getTier("open");
      expect(t).not.toBeNull();
      expect(t.name).toBe("open");
    });

    it("returns null for an unknown tier", () => {
      expect(tiers.getTier("nonexistent")).toBeNull();
    });
  });

  describe("tier: restricted", () => {
    it("has no presets — base sandbox policy only", () => {
      expect(tiers.getTier("restricted").presets).toHaveLength(0);
    });
  });

  describe("tier: balanced", () => {
    it("includes npm, pypi, huggingface, brew, and brave", () => {
      const names = tiers.getTier("balanced").presets.map((p: TierPreset) => p.name);
      expect(names).toContain("npm");
      expect(names).toContain("pypi");
      expect(names).toContain("huggingface");
      expect(names).toContain("brew");
      expect(names).toContain("brave");
    });

    it("has at least 5 presets", () => {
      expect(tiers.getTier("balanced").presets.length).toBeGreaterThanOrEqual(5);
    });

    it("all balanced presets are read-write", () => {
      for (const preset of tiers.getTier("balanced").presets) {
        expect(preset.access).toBe("read-write");
      }
    });

    it("does not include messaging presets (slack, discord, telegram)", () => {
      const names = tiers.getTier("balanced").presets.map((p: TierPreset) => p.name);
      expect(names).not.toContain("slack");
      expect(names).not.toContain("discord");
      expect(names).not.toContain("telegram");
    });
  });

  describe("tier: open", () => {
    it("has more presets than balanced", () => {
      const balancedCount = tiers.getTier("balanced").presets.length;
      const openCount = tiers.getTier("open").presets.length;
      expect(openCount).toBeGreaterThan(balancedCount);
    });

    it("all open presets are read-write", () => {
      for (const preset of tiers.getTier("open").presets) {
        expect(preset.access).toBe("read-write");
      }
    });

    it("includes messaging presets (slack, discord, telegram)", () => {
      const names = tiers.getTier("open").presets.map((p: TierPreset) => p.name);
      expect(names).toContain("slack");
      expect(names).toContain("discord");
      expect(names).toContain("telegram");
    });

    it("includes productivity presets (jira, outlook)", () => {
      const names = tiers.getTier("open").presets.map((p: TierPreset) => p.name);
      expect(names).toContain("jira");
      expect(names).toContain("outlook");
    });

    it("open tier contains all balanced presets by name", () => {
      const balancedNames = new Set(tiers.getTier("balanced").presets.map((p: TierPreset) => p.name));
      const openNames = new Set(tiers.getTier("open").presets.map((p: TierPreset) => p.name));
      for (const name of balancedNames) {
        expect(openNames.has(name)).toBe(true);
      }
    });
  });

  describe("resolveTierPresets", () => {
    it("returns default presets for balanced with no overrides", () => {
      const resolved: TierPreset[] = tiers.resolveTierPresets("balanced");
      expect(resolved.length).toBeGreaterThanOrEqual(5);
      for (const p of resolved) {
        expect(p.access).toBe("read-write");
      }
    });

    it("applies access override for a specific preset", () => {
      const resolved: TierPreset[] = tiers.resolveTierPresets("balanced", {
        overrides: { npm: "read" },
      });
      const npm = resolved.find((p: TierPreset) => p.name === "npm");
      expect(npm!.access).toBe("read");
      // other presets unchanged
      const pypi = resolved.find((p: TierPreset) => p.name === "pypi");
      expect(pypi!.access).toBe("read-write");
    });

    it("restricts to selected presets when selected list is provided", () => {
      const resolved: TierPreset[] = tiers.resolveTierPresets("balanced", {
        selected: ["npm", "pypi"],
      });
      expect(resolved).toHaveLength(2);
      const names = resolved.map((p: TierPreset) => p.name);
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
      const openTier = tiers.getTier("open");
      const resolved: TierPreset[] = tiers.resolveTierPresets("open");
      expect(resolved).toHaveLength(openTier.presets.length);
    });

    it("each resolved preset has name and access fields", () => {
      for (const tier of tiers.listTiers()) {
        for (const p of tiers.resolveTierPresets(tier.name)) {
          expect(typeof p.name).toBe("string");
          expect(typeof p.access).toBe("string");
          expect(p.access.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("integration: all tier presets exist on disk", () => {
    it("every preset referenced in tiers.yaml exists as a preset file", () => {
      const available = new Set(policies.listPresets().map((p: Preset) => p.name));
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
