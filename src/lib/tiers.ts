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

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { ROOT } from "./runner";

const TIERS_FILE = path.join(ROOT, "nemoclaw-blueprint", "policies", "tiers.yaml");
const ALLOWED_ACCESS: ReadonlySet<string> = new Set(["read", "read-write"]);
type TierAccess = "read" | "read-write";

export interface TierPreset {
  name: string;
  access: TierAccess;
}

export interface TierDefinition {
  name: string;
  label: string;
  description: string;
  presets: TierPreset[];
}

interface TierDocument {
  tiers: TierDefinition[];
}

interface ResolveTierPresetOptions {
  overrides?: Record<string, string>;
  selected?: string[] | null;
}

type TierYamlScalar = string | number | boolean | null | undefined;
type TierYamlValue = TierYamlScalar | TierYamlRecord | TierYamlValue[];
type TierYamlRecord = { [key: string]: TierYamlValue };

function isRecord(value: TierYamlValue): value is TierYamlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: TierYamlRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function isTierAccess(value: string): value is TierAccess {
  return ALLOWED_ACCESS.has(value);
}

function parseTierPreset(value: TierYamlValue, index: number, tierName: string): TierPreset {
  if (!isRecord(value)) {
    throw new Error(`tiers.yaml: tier '${tierName}' preset ${String(index)} is not an object`);
  }

  const name = readString(value, "name");
  const access = readString(value, "access");

  if (!name) {
    throw new Error(`tiers.yaml: tier '${tierName}' preset ${String(index)} is missing name`);
  }
  if (!access || !isTierAccess(access)) {
    throw new Error(
      `tiers.yaml: tier '${tierName}' preset '${name}' has invalid access '${String(access)}'`,
    );
  }

  return { name, access };
}

function parseTierDefinition(value: TierYamlValue, index: number): TierDefinition {
  if (!isRecord(value)) {
    throw new Error(`tiers.yaml: tier ${String(index)} is not an object`);
  }

  const name = readString(value, "name");
  const label = readString(value, "label");
  const description = readString(value, "description");
  const presetsValue = value.presets;

  if (!name) {
    throw new Error(`tiers.yaml: tier ${String(index)} is missing name`);
  }
  if (!label) {
    throw new Error(`tiers.yaml: tier '${name}' is missing label`);
  }
  if (!description) {
    throw new Error(`tiers.yaml: tier '${name}' is missing description`);
  }
  if (!Array.isArray(presetsValue)) {
    throw new Error(`tiers.yaml: tier '${name}' presets must be an array`);
  }

  return {
    name,
    label,
    description,
    presets: presetsValue.map((preset, presetIndex) => parseTierPreset(preset, presetIndex, name)),
  };
}

function parseTierDocument(raw: string): TierDocument {
  const parsed = YAML.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.tiers)) {
    throw new Error(`tiers.yaml: expected a top-level 'tiers' array in ${TIERS_FILE}`);
  }

  return {
    tiers: parsed.tiers.map((tier, index) => parseTierDefinition(tier, index)),
  };
}

/**
 * Load and return all tier definitions from tiers.yaml.
 * Preserves the order defined in the file (restrictive → open).
 */
function listTiers(): TierDefinition[] {
  const content = fs.readFileSync(TIERS_FILE, "utf-8");
  return parseTierDocument(content).tiers;
}

/**
 * Return a single tier definition by name.
 * Returns null if the tier does not exist.
 */
function getTier(name: string): TierDefinition | null {
  return listTiers().find((tier) => tier.name === name) ?? null;
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
 */
function resolveTierPresets(
  tierName: string,
  options: ResolveTierPresetOptions = {},
): TierPreset[] {
  const overrides = options.overrides ?? {};
  const selected = options.selected === undefined ? null : options.selected;
  const tier = getTier(tierName);
  if (!tier) {
    throw new Error(`Unknown tier: ${tierName}`);
  }

  let presets = tier.presets.map((preset): TierPreset => {
    const override = overrides[preset.name];
    return {
      name: preset.name,
      access: override && isTierAccess(override) ? override : preset.access,
    };
  });

  if (selected !== null) {
    const allowSet = new Set(selected);
    presets = presets.filter((preset) => allowSet.has(preset.name));
  }

  return presets;
}

export { TIERS_FILE, listTiers, getTier, resolveTierPresets };
