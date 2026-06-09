// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelInputSpec,
  ChannelManifest,
  ChannelManifestAvailabilityContext,
  MessagingAgentId,
  MessagingChannelId,
} from "./manifest";

export interface MessagingAgentDescriptor {
  readonly name?: string;
  readonly messagingPlatforms?: readonly MessagingChannelId[] | null;
}

export type MessagingInputResolver = (input: ChannelInputSpec) => string | null;

export function toMessagingAgentId(
  agent: MessagingAgentDescriptor | null | undefined,
): MessagingAgentId {
  return agent?.name === "hermes" ? "hermes" : "openclaw";
}

export function getMessagingManifestAvailabilityContext(
  agent: MessagingAgentDescriptor | null | undefined,
): ChannelManifestAvailabilityContext {
  return {
    agent: toMessagingAgentId(agent),
    supportedChannelIds:
      agent?.messagingPlatforms && agent.messagingPlatforms.length > 0
        ? agent.messagingPlatforms
        : null,
  };
}

export function resolveMessagingManifestSeed(
  manifests: readonly ChannelManifest[],
  existingChannels: readonly string[] | null | undefined,
  hasChannelRequiredInputs: (manifest: ChannelManifest) => boolean,
  { includeAllExisting = false }: { readonly includeAllExisting?: boolean } = {},
): string[] {
  const seeded = new Set(manifests.filter(hasChannelRequiredInputs).map((manifest) => manifest.id));
  if (!Array.isArray(existingChannels)) return Array.from(seeded);

  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  for (const channelId of existingChannels) {
    const manifest = manifestById.get(channelId);
    if (!manifest) continue;
    if (includeAllExisting || manifest.auth.mode === "in-sandbox-qr") {
      seeded.add(channelId);
    }
  }
  return Array.from(seeded);
}

export function hasMessagingManifestRequiredInputs(
  manifest: ChannelManifest,
  resolveInput: MessagingInputResolver,
): boolean {
  const requiredInputs = manifest.inputs.filter((input) => input.required);
  if (requiredInputs.length === 0) return false;
  return requiredInputs.every((input) => {
    if (!input.envKey) return false;
    return hasResolvedInputValue(resolveInput(input));
  });
}

function hasResolvedInputValue(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
