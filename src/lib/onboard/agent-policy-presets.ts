// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { HERMES_TOOL_GATEWAY_PRESET_NAMES } from "./hermes-managed-tools";
import { isOpenclawAgent, OPENCLAW_ONLY_POLICY_PRESETS } from "./openclaw-otel-policy-presets";

export { OPENCLAW_ONLY_POLICY_PRESETS };

function isHermesAgent(agent: string | null | undefined): boolean {
  return typeof agent === "string" && agent.trim().toLowerCase() === "hermes";
}

export function setupPolicyPresetAppliesToAgent(
  presetName: string,
  agent: string | null | undefined,
): boolean {
  const name = presetName.trim().toLowerCase();
  if (HERMES_TOOL_GATEWAY_PRESET_NAMES.has(name)) return isHermesAgent(agent);
  if (OPENCLAW_ONLY_POLICY_PRESETS.has(name)) return isOpenclawAgent(agent);
  return true;
}

export function filterSetupPolicyPresetsForAgent<T extends { name: string }>(
  presets: T[],
  agent: string | null | undefined,
): T[] {
  return presets.filter((preset) => setupPolicyPresetAppliesToAgent(preset.name, agent));
}

export function filterSetupPolicyPresetNamesForAgent(
  presetNames: string[],
  agent: string | null | undefined,
): string[] {
  return presetNames.filter((name) => setupPolicyPresetAppliesToAgent(name, agent));
}
