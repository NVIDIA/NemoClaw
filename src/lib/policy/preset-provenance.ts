// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { HERMES_TOOL_GATEWAY_PRESET_NAMES } from "../onboard/hermes-managed-tools";
import { OPENCLAW_ONLY_POLICY_PRESETS } from "../onboard/openclaw-otel-policy-presets";

export type PresetProvenance =
  | { source: "agent"; agent: "openclaw" | "hermes" }
  | { source: "user" };

export interface PresetProvenanceContext {
  agentName?: string | null;
}

export interface PresetVerificationState {
  active: boolean;
  observedInOpenShell: boolean | null;
}

/**
 * Infer display-only provenance from the agent baseline. All other live
 * entries are operator-added; NemoClaw does not persist policy history.
 */
export function classifyPresetProvenance(
  presetName: string,
  context: PresetProvenanceContext = {},
): PresetProvenance {
  const name = presetName.trim().toLowerCase();
  const agentName = context.agentName?.trim().toLowerCase() ?? null;
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
    case "agent":
      return `from ${provenance.agent} agent`;
    case "user":
      return "user-added";
  }
}

/** Format the display suffix without claiming provenance for unverified state. */
export function formatPresetProvenanceSuffix(
  presetName: string,
  context: PresetProvenanceContext,
  state: PresetVerificationState,
): string {
  if (!state.active) return "";
  if (state.observedInOpenShell === true) {
    return ` [${formatPresetProvenanceTag(classifyPresetProvenance(presetName, context))}]`;
  }
  return " [source unverified (gateway unreachable)]";
}
