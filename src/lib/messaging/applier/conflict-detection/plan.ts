// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../manifest";
import type { ConflictRequest } from "./types";

/**
 * Return the channel IDs that are active (not disabled) in a compiled plan.
 * Aligns with `enabledPlanChannels()` in plan-filter.ts: a channel is active
 * only when `channel.active && !channel.disabled` AND it is not in
 * `plan.disabledChannels`.
 */
export function getActiveChannelIdsFromPlan(plan: SandboxMessagingPlan): string[] {
  const disabled = new Set(plan.disabledChannels);
  return plan.channels
    .filter((c) => c.active && !c.disabled && !disabled.has(c.channelId))
    .map((c) => c.channelId);
}

/**
 * Return credential hashes keyed by providerEnvKey from a compiled plan,
 * optionally scoped to a single channel.
 *
 * Only bindings that carry a `credentialHash` are included. When `channelId`
 * is provided only that channel's bindings are returned, which prevents
 * hashes from other channels in the same sandbox from contaminating
 * single-channel conflict comparisons.
 */
export function getCredentialHashesFromPlan(
  plan: SandboxMessagingPlan,
  channelId?: string,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const b of plan.credentialBindings) {
    if (channelId !== undefined && b.channelId !== channelId) continue;
    if (b.credentialHash) hashes[b.providerEnvKey] = b.credentialHash;
  }
  return hashes;
}

/**
 * Build a `ConflictRequest[]` from a compiled plan's credential bindings.
 *
 * Groups bindings by channelId (e.g. Slack has SLACK_BOT_TOKEN and
 * SLACK_APP_TOKEN) and excludes:
 *   - channels in `plan.disabledChannels` (bridge is paused, not in use)
 *   - bindings where the credential is not available (`credentialAvailable`
 *     false) - e.g. WhatsApp, which has no host-side token provider
 *
 * When a binding has no `credentialHash` (e.g. a registry-only resume that
 * did not re-run the compiler), the channel is still included with an empty
 * `credentialHashes` map, which falls through to `"unknown-token"` conservative
 * detection.
 */
export function planToConflictChannelRequests(plan: SandboxMessagingPlan): ConflictRequest[] {
  const activeChannelIds = new Set(getActiveChannelIdsFromPlan(plan));
  const byChannel = new Map<string, Record<string, string>>();

  for (const binding of plan.credentialBindings) {
    if (!activeChannelIds.has(binding.channelId) || !binding.credentialAvailable) continue;
    const hashes = byChannel.get(binding.channelId) ?? {};
    if (binding.credentialHash) hashes[binding.providerEnvKey] = binding.credentialHash;
    byChannel.set(binding.channelId, hashes);
  }

  return Array.from(byChannel.entries()).map(([channel, credentialHashes]) => ({
    channel,
    credentialHashes,
  }));
}
