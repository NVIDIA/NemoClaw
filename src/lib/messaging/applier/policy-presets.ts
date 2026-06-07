// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL: Record<string, readonly string[]> = {
  slack: ["slack"],
};

/** All preset names that any messaging channel can require. */
export const ALL_MESSAGING_POLICY_PRESET_NAMES: ReadonlySet<string> = new Set(
  Object.values(REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL).flat(),
);

function normalizedNames(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const names: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim().toLowerCase();
    if (!name || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

function requiredMessagingChannelPolicyPresets(channels: string[] | null | undefined): string[] {
  const required: string[] = [];
  for (const channel of normalizedNames(channels)) {
    for (const preset of REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL[channel] || []) {
      if (!required.includes(preset)) required.push(preset);
    }
  }
  return required;
}

/**
 * Removes from selectedPresets any preset exclusively required by a disabled
 * channel. Used when restoring presets from backup manifests where no compiled
 * plan is available. For plan-aware paths, disabled channels are already
 * excluded from plan.networkPolicy.presets.
 */
export function pruneDisabledMessagingPolicyPresets(
  selectedPresets: string[],
  disabledChannels: string[] | null | undefined,
): string[] {
  const disabledRequiredPresets = new Set(requiredMessagingChannelPolicyPresets(disabledChannels));
  if (disabledRequiredPresets.size === 0) return selectedPresets;
  return selectedPresets.filter(
    (preset) => !disabledRequiredPresets.has(preset.trim().toLowerCase()),
  );
}
