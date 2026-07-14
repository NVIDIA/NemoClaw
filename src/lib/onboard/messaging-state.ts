// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
  createBuiltInChannelManifestRegistry,
  getMessagingManifestAvailabilityContext,
} from "../messaging";
import { channelUsesInSandboxQrPairing, type ChannelDef } from "../sandbox/channels";

export type MessagingChannel = { name: string } & ChannelDef;

export function resolveQrSelectedChannels(
  channels: MessagingChannel[],
  enabledChannels: string[] | null | undefined,
  disabledChannelNames: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(enabledChannels)) return [];
  return enabledChannels.filter((name) => {
    if (disabledChannelNames.has(name)) return false;
    const ch = channels.find((c) => c.name === name);
    return !!ch && channelUsesInSandboxQrPairing(ch);
  });
}

export function filterEnabledChannelsByAgent<T extends string[] | null | undefined>(
  enabledChannels: T,
  agent: AgentDefinition | null,
): T {
  if (!Array.isArray(enabledChannels)) return enabledChannels;
  if (!agent) return enabledChannels;
  const registry = createBuiltInChannelManifestRegistry();
  const available = registry.listAvailable(
    getMessagingManifestAvailabilityContext(agent, registry.list()),
  );
  if (available.length === 0) return [] as unknown as T;
  const supported = new Set(available.map((manifest) => manifest.id));
  return enabledChannels.filter((n) => supported.has(n)) as T;
}
