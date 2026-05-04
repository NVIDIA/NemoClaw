// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Cross-sandbox messaging-channel conflict detection.
//
// Telegram (getUpdates long-polling), Discord (gateway connection), and Slack
// (Socket Mode) all enforce one active consumer per channel credential. Two
// sandboxes sharing the same token silently break both bridges; see issue #1953.
//
// The registry persists which channels each sandbox uses plus a non-secret hash
// of the provider credential when available. This module detects true same-token
// overlaps and — because pre-existing sandboxes created before the field was
// added have no record — can optionally backfill the channel field by probing
// the live OpenShell gateway for known provider names.

import type { SandboxEntry } from "./registry";
import { getChannelDef, getChannelTokenKeys } from "./sandbox-channels";

type ProbeResult = "present" | "absent" | "error";
type ConflictReason = "matching-token" | "unknown-token";

interface ConflictProbe {
  // Tri-state — "error" is distinct from "absent" so a transient gateway
  // failure does not get collapsed into "provider not attached" and then
  // persisted as a bogus empty messagingChannels.
  providerExists: (name: string) => ProbeResult;
}

interface ConflictRegistry {
  listSandboxes: () => { sandboxes: SandboxEntry[]; defaultSandbox?: string | null };
  updateSandbox: (name: string, updates: Partial<SandboxEntry>) => boolean;
}

interface RequestedChannel {
  channel: string;
  credentialHashes?: Record<string, string | null | undefined>;
}

type ChannelRequest = string | RequestedChannel;

interface Conflict {
  channel: string;
  sandbox: string;
  reason: ConflictReason;
}

// NemoClaw attaches one OpenShell provider per messaging channel per sandbox.
// The provider name pattern is established in src/lib/onboard.ts at sandbox
// creation time; when a sandbox predates the messagingChannels registry field,
// the live provider is the only record of which channels it uses.
const PROVIDER_SUFFIXES: Record<string, string> = {
  telegram: "-telegram-bridge",
  discord: "-discord-bridge",
  slack: "-slack-bridge",
};

const KNOWN_CHANNELS = Object.keys(PROVIDER_SUFFIXES);

function normalizeRequest(request: ChannelRequest): RequestedChannel | null {
  if (typeof request === "string") {
    return request ? { channel: request, credentialHashes: {} } : null;
  }
  if (!request || typeof request.channel !== "string" || request.channel.length === 0) return null;
  return request;
}

function getTokenKeys(channel: string): string[] {
  const def = getChannelDef(channel);
  return def ? getChannelTokenKeys(def) : [];
}

function hasStoredChannel(entry: SandboxEntry, channel: string): boolean {
  return Array.isArray(entry.messagingChannels) && entry.messagingChannels.includes(channel);
}

function conflictReasonForRequest(
  entry: SandboxEntry,
  request: RequestedChannel,
): ConflictReason | null {
  if (!hasStoredChannel(entry, request.channel)) return null;
  const requestedHashes = request.credentialHashes || {};
  const storedHashes = entry.providerCredentialHashes || {};
  const tokenKeys = getTokenKeys(request.channel);
  const comparisonKeys = tokenKeys.length > 0 ? tokenKeys : Object.keys(requestedHashes);
  if (comparisonKeys.length === 0) return "unknown-token";

  let sawUnknown = false;
  for (const key of comparisonKeys) {
    const requestedHash = requestedHashes[key] || null;
    const storedHash = storedHashes[key] || null;
    if (requestedHash && storedHash) {
      if (requestedHash === storedHash) return "matching-token";
      continue;
    }
    sawUnknown = true;
  }
  return sawUnknown ? "unknown-token" : null;
}

function conflictReasonForPair(
  channel: string,
  left: SandboxEntry,
  right: SandboxEntry,
): ConflictReason | null {
  if (!hasStoredChannel(left, channel) || !hasStoredChannel(right, channel)) return null;
  const tokenKeys = getTokenKeys(channel);
  if (tokenKeys.length === 0) return "unknown-token";

  let sawUnknown = false;
  for (const key of tokenKeys) {
    const leftHash = left.providerCredentialHashes?.[key] || null;
    const rightHash = right.providerCredentialHashes?.[key] || null;
    if (leftHash && rightHash) {
      if (leftHash === rightHash) return "matching-token";
      continue;
    }
    sawUnknown = true;
  }
  return sawUnknown ? "unknown-token" : null;
}

/**
 * For registry entries missing `messagingChannels`, probe OpenShell to infer
 * which channels the sandbox was onboarded with, and write the result back to
 * the registry. Safe to call repeatedly — entries with the field set are left
 * alone. Failures to probe any one sandbox are swallowed so that a flaky
 * gateway does not block status or onboarding.
 */
export function backfillMessagingChannels(
  registry: ConflictRegistry,
  probe: ConflictProbe,
): void {
  const { sandboxes } = registry.listSandboxes();
  for (const entry of sandboxes) {
    if (Array.isArray(entry.messagingChannels)) continue;
    const discovered: string[] = [];
    let probeFailed = false;
    for (const channel of KNOWN_CHANNELS) {
      const providerName = `${entry.name}${PROVIDER_SUFFIXES[channel]}`;
      let state: ProbeResult;
      try {
        state = probe.providerExists(providerName);
      } catch {
        state = "error";
      }
      if (state === "present") {
        discovered.push(channel);
      } else if (state === "error") {
        // Partial results can't be persisted: writing a partial/empty list
        // sets messagingChannels, preventing future retries and permanently
        // hiding real overlaps. Skip the write so we retry on next call.
        probeFailed = true;
        break;
      }
    }
    if (!probeFailed) {
      registry.updateSandbox(entry.name, { messagingChannels: discovered });
    }
  }
}

/**
 * Return every (channel, other-sandbox) pair where another sandbox in the
 * registry already has one of the requested channels in use with either a
 * matching credential hash or insufficient hash metadata to prove it differs.
 */
export function findChannelConflicts(
  currentSandbox: string | null,
  enabledChannels: ChannelRequest[],
  registry: ConflictRegistry,
): Conflict[] {
  if (!Array.isArray(enabledChannels) || enabledChannels.length === 0) return [];
  const requests = enabledChannels.map(normalizeRequest).filter((r): r is RequestedChannel => !!r);
  if (requests.length === 0) return [];
  const { sandboxes } = registry.listSandboxes();
  const others = sandboxes.filter(
    (s) => s.name !== currentSandbox && Array.isArray(s.messagingChannels),
  );
  return requests.flatMap((request) =>
    others.flatMap((sandbox) => {
      const reason = conflictReasonForRequest(sandbox, request);
      return reason ? [{ channel: request.channel, sandbox: sandbox.name, reason }] : [];
    }),
  );
}

/**
 * Detect overlaps across every sandbox in the registry, returning each pair at
 * most once. Used by `nemoclaw status` to warn users whose sandboxes already
 * share a messaging token or whose legacy metadata is too old to verify.
 */
export function findAllOverlaps(registry: ConflictRegistry): Array<{
  channel: string;
  sandboxes: [string, string];
  reason: ConflictReason;
}> {
  const { sandboxes } = registry.listSandboxes();
  const byChannel = new Map<string, SandboxEntry[]>();
  for (const entry of sandboxes) {
    if (!Array.isArray(entry.messagingChannels)) continue;
    for (const channel of entry.messagingChannels) {
      const list = byChannel.get(channel) || [];
      list.push(entry);
      byChannel.set(channel, list);
    }
  }
  const overlaps: Array<{ channel: string; sandboxes: [string, string]; reason: ConflictReason }> =
    [];
  for (const [channel, entries] of byChannel) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const reason = conflictReasonForPair(channel, entries[i], entries[j]);
        if (reason) {
          overlaps.push({ channel, sandboxes: [entries[i].name, entries[j].name], reason });
        }
      }
    }
  }
  return overlaps;
}
