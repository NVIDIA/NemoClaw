// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DCODE_AGENT_NAME = "langchain-deepagents-code";
export const OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET = "observability-otlp-local";

export const DCODE_ONLY_POLICY_PRESETS = new Set<string>([OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET]);

export function isDcodeAgent(agent: string | null | undefined): boolean {
  return typeof agent === "string" && agent.trim().toLowerCase() === DCODE_AGENT_NAME;
}

export function requiredObservabilityPolicyPresets(
  agent: string | null | undefined,
  observabilityEnabled: boolean | null | undefined,
): string[] {
  return observabilityEnabled === true && isDcodeAgent(agent)
    ? [OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET]
    : [];
}

export function isInactiveObservabilityPolicyPreset(
  presetName: string,
  options: {
    agent?: string | null;
    observabilityEnabled?: boolean | null;
    customPresetNames?: ReadonlySet<string> | null;
  } = {},
): boolean {
  const name = presetName.trim().toLowerCase();
  if (options.customPresetNames?.has(name)) return false;
  return (
    name === OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET &&
    isDcodeAgent(options.agent) &&
    options.observabilityEnabled !== true
  );
}

export function mergeRequiredObservabilityPolicyPresets(
  selectedPresets: string[],
  options: {
    agent?: string | null;
    observabilityEnabled?: boolean | null;
    knownPresetNames?: Iterable<string> | null;
  } = {},
): string[] {
  const merged = [...selectedPresets];
  const selected = new Set(merged);
  const known = options.knownPresetNames ? new Set(options.knownPresetNames) : null;

  for (const preset of requiredObservabilityPolicyPresets(
    options.agent,
    options.observabilityEnabled,
  )) {
    if (known && !known.has(preset)) continue;
    if (selected.has(preset)) continue;
    merged.push(preset);
    selected.add(preset);
  }

  return merged;
}
