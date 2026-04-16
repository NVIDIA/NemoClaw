// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Cross-sandbox messaging-channel conflict detection.
//
// Telegram (getUpdates long-polling), Discord (gateway connection), and Slack
// (Socket Mode) all enforce one active consumer per bot token. Two sandboxes
// sharing the same token silently break both bridges; see issue #1953.
//
// The registry persists which channels each sandbox uses. This module detects
// overlaps and — because pre-existing sandboxes created before the field was
// added have no record — can optionally backfill the field by probing the live
// OpenShell gateway for known provider names.

import type { SandboxEntry } from "./registry";

type ProbeResult = "present" | "absent" | "error";

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

interface Conflict {
  channel: string;
  sandbox: string;
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
 * registry already has one of the `enabledChannels` in use.
 */
export function findChannelConflicts(
  currentSandbox: string | null,
  enabledChannels: string[],
  registry: ConflictRegistry,
): Conflict[] {
  if (!Array.isArray(enabledChannels) || enabledChannels.length === 0) return [];
  const { sandboxes } = registry.listSandboxes();
  const others = sandboxes.filter(
    (s) => s.name !== currentSandbox && Array.isArray(s.messagingChannels),
  );
  return enabledChannels.flatMap((channel) =>
    others
      .filter((s) => (s.messagingChannels || []).includes(channel))
      .map((s) => ({ channel, sandbox: s.name })),
  );
}

/**
 * Detect overlaps across every sandbox in the registry, returning each pair at
 * most once. Used by `nemoclaw status` to warn users whose sandboxes already
 * share a messaging token.
 */
export function findAllOverlaps(registry: ConflictRegistry): Array<{
  channel: string;
  sandboxes: [string, string];
}> {
  const { sandboxes } = registry.listSandboxes();
  const byChannel = new Map<string, string[]>();
  for (const entry of sandboxes) {
    if (!Array.isArray(entry.messagingChannels)) continue;
    for (const channel of entry.messagingChannels) {
      const list = byChannel.get(channel) || [];
      list.push(entry.name);
      byChannel.set(channel, list);
    }
  }
  const overlaps: Array<{ channel: string; sandboxes: [string, string] }> = [];
  for (const [channel, names] of byChannel) {
    if (names.length < 2) continue;
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        overlaps.push({ channel, sandboxes: [names[i], names[j]] });
      }
    }
  }
  return overlaps;
}
