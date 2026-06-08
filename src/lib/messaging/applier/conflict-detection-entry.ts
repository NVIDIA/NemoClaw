// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../manifest";
import { CHANNEL_CREDENTIAL_ENV_KEYS } from "./conflict-detection-manifest";
import {
  getActiveChannelIdsFromPlan,
  getCredentialHashesFromPlan,
  planToConflictChannelRequests,
} from "./conflict-detection-plan";
import type {
  ChannelConflictRequest,
  ConflictMatch,
  ConflictReason,
  ConflictRegistry,
  ConflictRegistryEntry,
  ConflictRequest,
} from "./conflict-detection-types";

function normalizeRequest(request: ChannelConflictRequest): ConflictRequest | null {
  if (typeof request === "string") {
    return request ? { channel: request, credentialHashes: {} } : null;
  }
  if (!request || typeof request.channel !== "string" || request.channel.length === 0) return null;
  return request;
}

/**
 * Return the active channel IDs for a registry entry.
 *
 * Uses `entry.messaging.plan` when available. Pre-plan registry entries are
 * supported only as a fail-closed compatibility signal via the legacy
 * `messagingChannels`/`disabledChannels` flat fields; their credential hashes
 * are intentionally not recovered here. Remove this branch when unsupported
 * registry versions are migrated or rejected before conflict detection.
 *
 * Returns `null` when the entry has neither shape.
 */
export function resolveActiveChannelsFromEntry(
  entry: ConflictRegistryEntry,
): string[] | null {
  if (entry.messaging?.plan) {
    return getActiveChannelIdsFromPlan(entry.messaging.plan);
  }
  if (!Array.isArray(entry.messagingChannels)) return null;
  const disabled = new Set(
    Array.isArray(entry.disabledChannels)
      ? entry.disabledChannels.filter((channel): channel is string => typeof channel === "string")
      : [],
  );
  return entry.messagingChannels
    .filter((channel): channel is string => typeof channel === "string")
    .filter((channel) => !disabled.has(channel));
}

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
 * True when `channel` is active in `entry`.
 * Disabled channels must not block another sandbox from claiming the same
 * token because the bridge is paused.
 */
export function hasStoredChannelInEntry(
  entry: ConflictRegistryEntry,
  channel: string,
): boolean {
  return resolveActiveChannelsFromEntry(entry)?.includes(channel) ?? false;
}

function comparisonKeys(
  channel: string,
  storedHashes: Record<string, string>,
  requestedHashes: Record<string, string | null | undefined>,
): string[] {
  const manifestKeys = CHANNEL_CREDENTIAL_ENV_KEYS[channel];
  if (manifestKeys && manifestKeys.length > 0) return [...manifestKeys];
  if (Object.keys(storedHashes).length > 0) return Object.keys(storedHashes);
  return Object.keys(requestedHashes);
}

/**
 * Determine the conflict reason between stored entry state and a new channel
 * request, or `null` if there is no conflict.
 */
export function conflictReasonForRequest(
  entry: ConflictRegistryEntry,
  request: ConflictRequest,
): ConflictReason | null {
  if (!hasStoredChannelInEntry(entry, request.channel)) return null;
  const requestedHashes = request.credentialHashes ?? {};
  const storedHashes = resolveChannelHashesFromEntry(entry, request.channel);
  const keys = comparisonKeys(request.channel, storedHashes, requestedHashes);
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
 * Determine the conflict reason between two registry entries sharing a channel,
 * or `null` if there is no conflict.
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
 * Return every requested channel where another sandbox already has a matching
 * credential hash or insufficient hash metadata to prove it differs.
 */
export function findConflictsInEntries(
  currentSandbox: string | null,
  requests: readonly ConflictRequest[],
  entries: readonly ConflictRegistryEntry[],
): ConflictMatch[] {
  const others = entries.filter((entry) => entry.name !== currentSandbox);
  return requests.flatMap((request) =>
    others.flatMap((entry) => {
      const reason = conflictReasonForRequest(entry, request);
      return reason ? [{ channel: request.channel, sandbox: entry.name, reason }] : [];
    }),
  );
}

export function findChannelConflicts(
  currentSandbox: string | null,
  enabledChannels: ChannelConflictRequest[],
  registry: ConflictRegistry,
): ConflictMatch[] {
  if (!Array.isArray(enabledChannels) || enabledChannels.length === 0) return [];
  const requests = enabledChannels
    .map(normalizeRequest)
    .filter((request): request is ConflictRequest => request !== null);
  if (requests.length === 0) return [];
  const { sandboxes } = registry.listSandboxes();
  return findConflictsInEntries(currentSandbox, requests, sandboxes);
}

export function findChannelConflictsFromPlan(
  currentSandbox: string | null,
  plan: SandboxMessagingPlan,
  registry: ConflictRegistry,
): ConflictMatch[] {
  return findChannelConflicts(currentSandbox, planToConflictChannelRequests(plan), registry);
}

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

export function findAllOverlaps(
  registry: ConflictRegistry,
): Array<{ channel: string; sandboxes: [string, string]; reason: ConflictReason }> {
  const { sandboxes } = registry.listSandboxes();
  return detectAllOverlapsInEntries(sandboxes);
}
