// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { HERMES_TOOL_GATEWAY_PRESET_NAMES } from "../onboard/hermes-tool-gateway-preset-names";
import { OPENCLAW_ONLY_POLICY_PRESETS } from "../onboard/openclaw-otel-policy-presets";
import { getTier } from "./tiers";

export type PresetProvenance =
  | { source: "tier"; tier: string }
  | { source: "agent"; agent: "openclaw" | "hermes" }
  | { source: "user" };

export interface PresetProvenanceContext {
  tierName?: string | null;
  agentName?: string | null;
}

/**
 * Infer display-only provenance from the sandbox's current tier and agent.
 * A current tier-name match takes precedence over agent and user fallbacks;
 * application history is not persisted, so a later user-added preset that
 * shadows a tier name is intentionally displayed as tier-derived.
 */
export function classifyPresetProvenance(
  presetName: string,
  context: PresetProvenanceContext = {},
): PresetProvenance {
  const name = presetName.trim().toLowerCase();
  const tierName = context.tierName?.trim().toLowerCase() || null;
  const agentName = context.agentName?.trim().toLowerCase() ?? null;
  if (tierName) {
    const tierDef = getTier(tierName);
    if (tierDef?.presets.some((preset) => preset.name === name)) {
      return { source: "tier", tier: tierDef.name };
    }
  }
  if (agentName === "openclaw" && OPENCLAW_ONLY_POLICY_PRESETS.has(name)) {
    return { source: "agent", agent: "openclaw" };
  }
  if (agentName === "hermes" && HERMES_TOOL_GATEWAY_PRESET_NAMES.has(name)) {
    return { source: "agent", agent: "hermes" };
  }
  return { source: "user" };
}

export function formatPresetProvenanceTag(provenance: PresetProvenance): string {
  switch (provenance.source) {
    case "tier":
      return `from ${provenance.tier} tier`;
    case "agent":
      return `from ${provenance.agent} agent`;
    case "user":
      return "user-added";
  }
}
