// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  listMessagingPolicyPresetsByChannel,
  listRequiredCreateTimeMessagingPolicyPresetsByChannel,
} from "../messaging/channels";

const REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL =
  listRequiredCreateTimeMessagingPolicyPresetsByChannel();

const ALL_POLICY_PRESETS_BY_MESSAGING_CHANNEL = listMessagingPolicyPresetsByChannel();

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

// Merge the policy presets every enabled messaging channel needs into a
// selection. An enabled channel cannot function without its network-egress
// preset, so that preset must survive policy finalization regardless of how the
// operator arrived at the selection (interactive tier, env-driven custom list,
// or a recorded resume set). We intentionally merge *all* of a channel's
// presets, not just the create-time `requiredAtCreate` ones: `requiredAtCreate`
// governs whether a preset is injected into the boot policy at sandbox-create
// time (only Slack today), while finalization applies any newly-merged preset
// to the live gateway itself. Using only the create-time-required set here drops
// every other channel's preset (Discord, Telegram, WhatsApp, Teams, WeChat) from
// the persisted selection, so `policy-list` shows them unapplied even though the
// channel was configured during onboard. See #5967.
export function mergeEnabledMessagingChannelPolicyPresets(
  selectedPresets: string[],
  channels: string[] | null | undefined,
  knownPresetNames?: Iterable<string> | null,
): string[] {
  const merged = [...selectedPresets];
  const selected = new Set(merged);
  const known = knownPresetNames ? new Set(knownPresetNames) : null;

  for (const preset of allMessagingChannelPolicyPresets(channels)) {
    if (known && !known.has(preset)) continue;
    if (selected.has(preset)) continue;
    merged.push(preset);
    selected.add(preset);
  }

  return merged;
}

export function allMessagingChannelPolicyPresets(channels: string[] | null | undefined): string[] {
  const all: string[] = [];
  for (const channel of normalizedNames(channels)) {
    for (const preset of ALL_POLICY_PRESETS_BY_MESSAGING_CHANNEL[channel] || []) {
      if (!all.includes(preset)) all.push(preset);
    }
  }
  return all;
}

export function pruneDisabledMessagingPolicyPresets(
  selectedPresets: string[],
  disabledChannels: string[] | null | undefined,
): string[] {
  const disabledChannelPresets = new Set(allMessagingChannelPolicyPresets(disabledChannels));
  if (disabledChannelPresets.size === 0) return selectedPresets;
  return selectedPresets.filter(
    (preset) => !disabledChannelPresets.has(preset.trim().toLowerCase()),
  );
}

/**
 * Recover the desired preset set after stop+rebuild pruned disabled-channel
 * egress from persisted policies and a later start+rebuild re-enabled those
 * channels. The backup manifest is authoritative when present, with the
 * registry as the stale-sandbox fallback; the current messaging plan owns
 * enabled/disabled state, and channel manifests own channel-to-preset mapping.
 * The helper and caller boundaries are covered in messaging-policy-presets.test.ts
 * and rebuild-flow.test.ts, respectively.
 *
 * Remove this recovery merge when the registry or planner durably persists one
 * canonical desired preset set across stop/start rebuilds.
 */
export function mergeRebuildMessagingPolicyPresets(
  backupPresets: string[] | null | undefined,
  registryPresets: string[],
  enabledChannels: string[] | null | undefined,
  disabledChannels: string[] | null | undefined,
): string[] {
  const persistedPresets = backupPresets ?? registryPresets;
  return [
    ...new Set([
      ...pruneDisabledMessagingPolicyPresets(persistedPresets, disabledChannels),
      ...pruneDisabledMessagingPolicyPresets(
        allMessagingChannelPolicyPresets(enabledChannels),
        disabledChannels,
      ),
    ]),
  ];
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
