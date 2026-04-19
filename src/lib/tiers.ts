// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tier management — load tier definitions and resolve preset selections.
//
// Tiers are defined in nemoclaw-blueprint/policies/tiers.yaml.
// Each tier is a named posture (restricted, balanced, open) that maps to
// a set of policy presets and their default access levels.
//
// The base sandbox policy is always applied regardless of tier.
// Tiers layer additional presets on top of that baseline.

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { ROOT } = require("./runner");

const TIERS_FILE = path.join(ROOT, "nemoclaw-blueprint", "policies", "tiers.yaml");

/**
 * Load and return all tier definitions from tiers.yaml.
 * Preserves the order defined in the file (restrictive → open).
 *
 * @returns {{ name: string, label: string, description: string, presets: Array<{name: string, access: string}> }[]}
 */
function listTiers() {
  const content = fs.readFileSync(TIERS_FILE, "utf-8");
  const parsed = YAML.parse(content);
  return parsed.tiers;
}

/**
 * Return a single tier definition by name.
 * Returns null if the tier does not exist.
 *
 * @param {string} name
 * @returns {{ name: string, label: string, description: string, presets: Array<{name: string, access: string}> } | null}
 */
function getTier(name) {
  return listTiers().find((t) => t.name === name) ?? null;
}

/**
 * Resolve the final preset list for a tier, applying any per-preset access
 * overrides supplied by the user.
 *
 * overrides is a map of preset name → access level, e.g.:
 *   { npm: "read-write", huggingface: "read" }
 *
 * Presets can also be excluded by passing a `selected` allowlist — only
 * presets whose names appear in the list are kept.
 *
 * @param {string} tierName
 * @param {{ overrides?: Record<string, string>, selected?: string[] | null }} [options]
 * @returns {{ name: string, access: string }[]}
 */
function resolveTierPresets(tierName, options = {}) {
  const overrides = options.overrides || {};
  const selected = options.selected === undefined ? null : options.selected;
  const tier = getTier(tierName);
  if (!tier) {
    throw new Error(`Unknown tier: ${tierName}`);
  }

  let presets = tier.presets.map((p) => ({
    name: p.name,
    access: overrides[p.name] ?? p.access,
  }));

  if (selected !== null) {
    const allowSet = new Set(selected);
    presets = presets.filter((p) => allowSet.has(p.name));
  }

  return presets;
}

export {
  TIERS_FILE,
  listTiers,
  getTier,
  resolveTierPresets,
};
