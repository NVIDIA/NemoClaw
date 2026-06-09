// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL: Record<string, readonly string[]> = {
  slack: ["slack"],
};

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

export function mergePolicyMessagingChannels(
  selectedChannels: string[] | null | undefined,
  recordedChannels: string[] | null | undefined,
  activeChannels: string[] | null | undefined,
  disabledChannels: string[] | null | undefined = null,
): string[] {
  const disabled = new Set(normalizedNames(disabledChannels));
  const merged: string[] = [];
  for (const channels of [selectedChannels, recordedChannels, activeChannels]) {
    for (const channel of normalizedNames(channels)) {
      if (!channel || disabled.has(channel) || merged.includes(channel)) continue;
      merged.push(channel);
    }
  }
  return merged;
}

export function requiredMessagingChannelPolicyPresets(
  channels: string[] | null | undefined,
): string[] {
  const required: string[] = [];
  for (const channel of normalizedNames(channels)) {
    for (const preset of REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL[channel] || []) {
      if (!required.includes(preset)) required.push(preset);
    }
  }
  return required;
}

export function mergeRequiredMessagingChannelPolicyPresets(
  selectedPresets: string[],
  channels: string[] | null | undefined,
  knownPresetNames?: Iterable<string> | null,
): string[] {
  const merged = [...selectedPresets];
  const selected = new Set(merged);
  const known = knownPresetNames ? new Set(knownPresetNames) : null;

  for (const preset of requiredMessagingChannelPolicyPresets(channels)) {
    if (known && !known.has(preset)) continue;
    if (selected.has(preset)) continue;
    merged.push(preset);
    selected.add(preset);
  }

  return merged;
}

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

export function hasDisabledMessagingPolicyPreset(
  selectedPresets: string[],
  disabledChannels: string[] | null | undefined,
): boolean {
  return (
    pruneDisabledMessagingPolicyPresets(selectedPresets, disabledChannels).length !==
    selectedPresets.length
  );
}

export function mergeAppliedPolicyPresetsForDisabledMessagingCleanup(
  selectedPresets: string[],
  appliedPresets: string[],
  disabledChannels: string[] | null | undefined,
): string[] {
  if (!hasDisabledMessagingPolicyPreset(appliedPresets, disabledChannels)) {
    return selectedPresets;
  }

  const merged = [...selectedPresets];
  for (const preset of pruneDisabledMessagingPolicyPresets(appliedPresets, disabledChannels)) {
    if (!merged.includes(preset)) merged.push(preset);
  }
  return merged;
}
