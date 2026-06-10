// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BASE_GATEWAY_NAME } from "../../../onboard/gateway-binding";
import { resolveActiveChannelsFromEntry } from "./entries";
import type { ConflictRegistryEntry } from "./types";

/**
 * Gateway-scoped Slack Socket Mode conflict detection (#4953).
 *
 * Slack Socket Mode is special among NemoClaw's messaging channels: the
 * conflict is *gateway-scoped*, not only credential-scoped. Even when two
 * sandboxes use two distinct Slack apps (different bot/app tokens), only one
 * sandbox per OpenShell gateway reliably receives Socket Mode events — the
 * effective runtime routes events to a single registered consumer, so a second
 * Slack sandbox on the same gateway silently receives nothing while NemoClaw
 * still reports its bridge as healthy (the silent black hole in #4953).
 *
 * The credential-based detection in `entries.ts` (`matching-token` /
 * `unknown-token`) catches the *same-token* case, which also covers two
 * sandboxes on *different* gateways sharing one Slack app. This module is the
 * complementary axis: same *gateway*, regardless of whether the tokens differ.
 * Both run together — neither subsumes the other.
 *
 * The gateway a sandbox is bound to is identified by its OpenShell gateway
 * registration name (`SandboxEntry.gatewayName`), which the per-port resolver
 * derives 1:1 from the gateway port (default port -> `nemoclaw`, any other port
 * -> `nemoclaw-<port>`; see `onboard/gateway-binding.ts` and #4422). The name is
 * therefore the authoritative gateway key. Entries created before per-port
 * gateway naming have no recorded name and were always on the default gateway,
 * so a missing name normalizes to `nemoclaw`.
 */

export const SLACK_CHANNEL_ID = "slack";

/**
 * The OpenShell gateway registration name a registry entry is bound to.
 * A missing/null name normalizes to the default `nemoclaw` gateway so legacy
 * entries (and entries on the default port) compare equal to a current onboard
 * targeting the default gateway.
 */
export function resolveEntryGatewayName(entry: ConflictRegistryEntry): string {
  return entry.gatewayName ?? BASE_GATEWAY_NAME;
}

/** True when the entry has Slack active (present and not disabled). */
export function entryHasActiveSlack(entry: ConflictRegistryEntry): boolean {
  return resolveActiveChannelsFromEntry(entry)?.includes(SLACK_CHANNEL_ID) ?? false;
}

export interface SlackGatewayConflict {
  /** The other sandbox already holding Slack Socket Mode on this gateway. */
  readonly sandbox: string;
  /** The shared gateway registration name. */
  readonly gatewayName: string;
}

/**
 * Return every *other* sandbox bound to `currentGatewayName` that already has
 * Slack active. Used by the onboard and `channels add` paths to warn/block
 * before a second Slack Socket Mode bridge is added to the same gateway.
 */
export function findSlackSocketModeGatewayConflicts(
  currentSandbox: string | null,
  currentGatewayName: string,
  entries: readonly ConflictRegistryEntry[],
): SlackGatewayConflict[] {
  return entries
    .filter((entry) => entry.name !== currentSandbox)
    .filter((entry) => entryHasActiveSlack(entry))
    .filter((entry) => resolveEntryGatewayName(entry) === currentGatewayName)
    .map((entry) => ({ sandbox: entry.name, gatewayName: currentGatewayName }));
}

export interface SlackGatewayOverlap {
  readonly gatewayName: string;
  readonly sandboxes: [string, string];
}

/**
 * Detect Slack Socket Mode gateway overlaps across all entries, returning each
 * pair at most once. Used by `nemoclaw status` to mark a second Slack sandbox
 * on a shared gateway as conflicted rather than silently healthy.
 */
export function detectAllSlackSocketModeGatewayOverlaps(
  entries: readonly ConflictRegistryEntry[],
): SlackGatewayOverlap[] {
  const byGateway = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entryHasActiveSlack(entry)) continue;
    const gatewayName = resolveEntryGatewayName(entry);
    const list = byGateway.get(gatewayName) ?? [];
    list.push(entry.name);
    byGateway.set(gatewayName, list);
  }

  const overlaps: SlackGatewayOverlap[] = [];
  for (const [gatewayName, names] of byGateway) {
    if (names.length < 2) continue;
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        overlaps.push({ gatewayName, sandboxes: [names[i], names[j]] });
      }
    }
  }
  return overlaps;
}

/**
 * The canonical operator-facing message for a Slack Socket Mode gateway
 * conflict. Worded to match the issue's expected behavior (#4953): one
 * sandbox per gateway receives Socket Mode events unless the gateway
 * multiplexes.
 */
export function formatSlackSocketModeConflictMessage(otherSandbox: string): string {
  return (
    `Slack Socket Mode is already enabled for sandbox '${otherSandbox}' on this gateway; ` +
    "only one sandbox can receive Slack Socket Mode events unless the gateway supports multiplexing."
  );
}
