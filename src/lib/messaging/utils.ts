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

const MESSAGING_AGENT_IDS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const satisfies readonly MessagingAgentId[];

export class MessagingAgentNotSupportedError extends Error {
  readonly agentName: string;
  constructor(agentName: string) {
    super(
      `Agent '${agentName}' does not support messaging. Supported agents: ${MESSAGING_AGENT_IDS.join(", ")}.`,
    );
    this.name = "MessagingAgentNotSupportedError";
    this.agentName = agentName;
  }
}

export function tryGetMessagingAgentId(
  agent: MessagingAgentDescriptor | null | undefined,
): MessagingAgentId | null {
  const name = agent?.name;
  return (MESSAGING_AGENT_IDS as readonly string[]).includes(name ?? "")
    ? (name as MessagingAgentId)
    : null;
}

export function toMessagingAgentId(
  agent: MessagingAgentDescriptor | null | undefined,
): MessagingAgentId {
  const name = agent?.name;
  if (typeof name !== "string" || name.trim() === "") {
    return "openclaw";
  }
  const id = tryGetMessagingAgentId(agent);
  if (id === null) {
    throw new MessagingAgentNotSupportedError(name);
  }
  return id;
}

export function isMessagingSupportedAgent(
  agent: MessagingAgentDescriptor | null | undefined,
): boolean {
  if (tryGetMessagingAgentId(agent) === null) return false;
  const platforms = agent?.messagingPlatforms;
  return !Array.isArray(platforms) || platforms.length > 0;
}

export function getMessagingManifestAvailabilityContext(
  agent: MessagingAgentDescriptor | null | undefined,
): ChannelManifestAvailabilityContext {
  const id = tryGetMessagingAgentId(agent);
  const platforms = agent?.messagingPlatforms;
  return {
    agent: id,
    supportedChannelIds: Array.isArray(platforms) ? platforms : null,
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
