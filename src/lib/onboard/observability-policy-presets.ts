// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ManagedPolicyBinding } from "../policy/managed-policy-binding";
import {
  type ManagedSandboxFeature,
  managedSandboxFeatureHasDrift,
} from "./managed-sandbox-feature";

export const DCODE_AGENT_NAME = "langchain-deepagents-code";
export const OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET = "observability-otlp-local";
export const OBSERVABILITY_POLICY_BINDING = new ManagedPolicyBinding({
  presetName: OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
});

export const DCODE_ONLY_POLICY_PRESETS = new Set<string>([OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET]);

export function isDcodeAgent(agent: string | null | undefined): boolean {
  return typeof agent === "string" && agent.trim().toLowerCase() === DCODE_AGENT_NAME;
}

export const DCODE_OBSERVABILITY_FEATURE: ManagedSandboxFeature<boolean> = {
  id: "observability",
  defaultValue: false,
  isValue: (value): value is boolean => typeof value === "boolean",
  isEnabled: (value) => value,
  supportsAgent: isDcodeAgent,
};

export function hasDcodeObservabilityDrift(options: {
  liveExists: boolean;
  managedDcodeAgent: boolean;
  hasRegistryEntry: boolean;
  recordedObservabilityEnabled: boolean | null | undefined;
  requestedObservabilityEnabled: boolean | null | undefined;
}): boolean {
  return managedSandboxFeatureHasDrift(DCODE_OBSERVABILITY_FEATURE, {
    liveExists: options.liveExists,
    hasRegistryEntry: options.hasRegistryEntry,
    agent: options.managedDcodeAgent ? DCODE_AGENT_NAME : null,
    recordedValue: options.recordedObservabilityEnabled,
    desiredValue: options.requestedObservabilityEnabled === true,
  });
}

export function hasRegisteredDcodeObservabilityDrift(
  liveExists: boolean,
  managedDcodeAgent: boolean,
  registryEntry: { observabilityEnabled?: boolean | null } | null,
  requestedObservabilityEnabled: boolean | null | undefined,
): boolean {
  return hasDcodeObservabilityDrift({
    liveExists,
    managedDcodeAgent,
    hasRegistryEntry: registryEntry !== null,
    recordedObservabilityEnabled: registryEntry?.observabilityEnabled,
    requestedObservabilityEnabled,
  });
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
    customOwnsObservability?: boolean;
  } = {},
): boolean {
  const name = presetName.trim().toLowerCase();
  if (options.customPresetNames?.has(name)) return false;
  if (name === OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET && options.customOwnsObservability) {
    return true;
  }
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
    customOwnsObservability?: boolean;
  } = {},
): string[] {
  const merged = [...selectedPresets];
  const selected = new Set(merged);
  const known = options.knownPresetNames ? new Set(options.knownPresetNames) : null;

  for (const preset of requiredObservabilityPolicyPresets(
    options.agent,
    options.observabilityEnabled,
  )) {
    if (options.customOwnsObservability) continue;
    if (known && !known.has(preset)) continue;
    if (selected.has(preset)) continue;
    merged.push(preset);
    selected.add(preset);
  }

  return merged;
}
