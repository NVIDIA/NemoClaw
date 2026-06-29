// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CHANNEL_CREDENTIAL_ENV_KEYS } from "./manifest-metadata";
import { getActiveChannelIdsFromPlan, getCredentialHashesFromPlan } from "./plan";
import type {
  ConflictMatch,
  ConflictReason,
  ConflictRegistryEntry,
  ConflictRequest,
} from "./types";

/**
 * Return the active (non-disabled) channel IDs for a registry entry.
 * `entry.messaging.plan` is the only supported persisted messaging state.
 * Entries without a plan have no supported messaging state.
 */
export function resolveActiveChannelsFromEntry(entry: ConflictRegistryEntry): string[] | null {
  if (entry.messaging?.plan) {
    return getActiveChannelIdsFromPlan(entry.messaging.plan);
  }
  return null;
}

/**
 * Return credential hashes scoped to `channelId` for a registry entry.
 */
function resolveChannelHashesFromEntry(
  entry: ConflictRegistryEntry,
  channelId: string,
): Record<string, string> {
  if (entry.messaging?.plan) {
    return getCredentialHashesFromPlan(entry.messaging.plan, channelId);
  }
  return {};
}

/**
 * True when `channel` is active (present and not disabled) in `entry`.
 * Disabled channels must not block another sandbox from claiming the same
 * token: the bridge is paused so the credential is not in use.
 */
export function hasStoredChannelInEntry(entry: ConflictRegistryEntry, channel: string): boolean {
  return resolveActiveChannelsFromEntry(entry)?.includes(channel) ?? false;
}

/**
 * Determine the conflict reason between `entry`'s stored state and a new
 * channel request, or `null` if there is no conflict.
 *
 * Comparison keys are taken from manifest-declared credentials for the channel
 * so that a missing hash for one of multiple required credentials (e.g. Slack's
 * SLACK_APP_TOKEN when only SLACK_BOT_TOKEN differs) conservatively marks the
 * result as "unknown-token" rather than silently returning null. Falls back to
 * the union of present stored/requested keys for channels not in the manifest.
 */
export function conflictReasonForRequest(
  entry: ConflictRegistryEntry,
  request: ConflictRequest,
): ConflictReason | null {
  if (!hasStoredChannelInEntry(entry, request.channel)) return null;
  const requestedHashes = request.credentialHashes ?? {};
  const storedHashes = resolveChannelHashesFromEntry(entry, request.channel);
  const manifestKeys = CHANNEL_CREDENTIAL_ENV_KEYS[request.channel];
  const keys =
    manifestKeys && manifestKeys.length > 0
      ? [...manifestKeys]
      : Object.keys(storedHashes).length > 0
        ? Object.keys(storedHashes)
        : Object.keys(requestedHashes);
  if (keys.length === 0) return null;

  let sawUnknown = false;
  for (const key of keys) {
    const rh = (requestedHashes[key] as string | null | undefined) ?? null;
    const sh = storedHashes[key] ?? null;
    if (rh && sh) {
      if (rh === sh) return "matching-token";
      continue;
    }
    sawUnknown = true;
  }
  return sawUnknown ? "unknown-token" : null;
}

/**
 * Determine the conflict reason between two registry entries sharing `channel`,
 * or `null` if there is no conflict. Returns each pair at most once (the
 * caller is responsible for ordered iteration).
 *
 * Comparison keys are taken from manifest-declared credentials for the channel
 * so that a missing hash on either side conservatively produces "unknown-token"
 * rather than null for multi-credential channels like Slack.
 */
export function conflictReasonForPair(
  channel: string,
  left: ConflictRegistryEntry,
  right: ConflictRegistryEntry,
): ConflictReason | null {
  if (!hasStoredChannelInEntry(left, channel) || !hasStoredChannelInEntry(right, channel)) {
    return null;
  }
  const lh = resolveChannelHashesFromEntry(left, channel);
  const rh = resolveChannelHashesFromEntry(right, channel);
  const manifestKeys = CHANNEL_CREDENTIAL_ENV_KEYS[channel];
  const keys =
    manifestKeys && manifestKeys.length > 0
      ? [...manifestKeys]
      : [...new Set([...Object.keys(lh), ...Object.keys(rh)])];
  if (keys.length === 0) return null;

  let sawUnknown = false;
  for (const key of keys) {
    const l = lh[key] ?? null;
    const r = rh[key] ?? null;
    if (l && r) {
      if (l === r) return "matching-token";
      continue;
    }
    sawUnknown = true;
  }
  return sawUnknown ? "unknown-token" : null;
}

/**
 * Return every (channel, other-sandbox) pair where another entry already has
 * one of the requested channels in use with either a matching credential hash
 * or insufficient hash metadata to prove it differs.
 */
export function findConflictsInEntries(
  currentSandbox: string | null,
  requests: readonly ConflictRequest[],
  entries: readonly ConflictRegistryEntry[],
): ConflictMatch[] {
  const others = entries.filter((e) => e.name !== currentSandbox && e.messaging?.plan != null);
  return requests.flatMap((request) =>
    others.flatMap((entry) => {
      const reason = conflictReasonForRequest(entry, request);
      return reason ? [{ channel: request.channel, sandbox: entry.name, reason }] : [];
    }),
  );
}

/**
 * Detect overlaps across all entries, returning each pair at most once.
 * Used by `nemoclaw status` to surface sandboxes that already share a token.
 */
export function detectAllOverlapsInEntries(
  entries: readonly ConflictRegistryEntry[],
): Array<{ channel: string; sandboxes: [string, string]; reason: ConflictReason }> {
  const byChannel = new Map<string, ConflictRegistryEntry[]>();
  for (const entry of entries) {
    const activeChannels = resolveActiveChannelsFromEntry(entry);
    if (!activeChannels) continue;
    for (const channel of activeChannels) {
      const list = byChannel.get(channel) ?? [];
      list.push(entry);
      byChannel.set(channel, list);
    }
  }

  const overlaps: Array<{
    channel: string;
    sandboxes: [string, string];
    reason: ConflictReason;
  }> = [];
  for (const [channel, channelEntries] of byChannel) {
    if (channelEntries.length < 2) continue;
    for (let i = 0; i < channelEntries.length; i += 1) {
      for (let j = i + 1; j < channelEntries.length; j += 1) {
        const reason = conflictReasonForPair(channel, channelEntries[i], channelEntries[j]);
        if (reason) {
          overlaps.push({
            channel,
            sandboxes: [channelEntries[i].name, channelEntries[j].name],
            reason,
          });
        }
      }
    }
  }
  return overlaps;
}
