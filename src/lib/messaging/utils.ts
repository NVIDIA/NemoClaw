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
}

export type MessagingInputResolver = (input: ChannelInputSpec) => string | null;

export class MessagingAgentNotSupportedError extends Error {
  readonly agentName: string;
  constructor(agentName: string, supportedAgentIds: readonly MessagingAgentId[]) {
    super(
      `Agent '${agentName}' does not support messaging. Supported agents: ${formatSupportedMessagingAgentIds(supportedAgentIds)}.`,
    );
    this.name = "MessagingAgentNotSupportedError";
    this.agentName = agentName;
  }
}

export function listSupportedMessagingAgentIds(
  manifests: readonly ChannelManifest[],
): MessagingAgentId[] {
  return [...new Set(manifests.flatMap((manifest) => manifest.supportedAgents))];
}

export function listSupportedMessagingChannelIdsForAgent(
  manifests: readonly ChannelManifest[],
  agentId: MessagingAgentId,
): MessagingChannelId[] {
  return manifests
    .filter((manifest) => manifest.supportedAgents.includes(agentId))
    .map((manifest) => manifest.id);
}

export function isMessagingChannelSupportedByAgent(
  manifest: ChannelManifest,
  agent: MessagingAgentDescriptor | null | undefined,
): boolean {
  const name = typeof agent?.name === "string" ? agent.name.trim() : "";
  return name !== "" && (manifest.supportedAgents as readonly string[]).includes(name);
}

export function tryGetMessagingAgentId(
  agent: MessagingAgentDescriptor | null | undefined,
  manifests: readonly ChannelManifest[],
): MessagingAgentId | null {
  const name = agent?.name;
  return (listSupportedMessagingAgentIds(manifests) as readonly string[]).includes(name ?? "")
    ? (name as MessagingAgentId)
    : null;
}

export function toMessagingAgentId(
  agent: MessagingAgentDescriptor | null | undefined,
  manifests: readonly ChannelManifest[],
): MessagingAgentId {
  const name = agent?.name;
  if (typeof name !== "string" || name.trim() === "") {
    const supported = listSupportedMessagingAgentIds(manifests);
    if (supported.includes("openclaw")) return "openclaw";
    throw new MessagingAgentNotSupportedError("openclaw", supported);
  }
  const id = tryGetMessagingAgentId(agent, manifests);
  if (id === null) {
    throw new MessagingAgentNotSupportedError(name, listSupportedMessagingAgentIds(manifests));
  }
  return id;
}

export function isMessagingSupportedAgent(
  agent: MessagingAgentDescriptor | null | undefined,
  manifests: readonly ChannelManifest[],
): boolean {
  const agentId = tryGetMessagingAgentId(agent, manifests);
  return (
    agentId !== null && listSupportedMessagingChannelIdsForAgent(manifests, agentId).length > 0
  );
}

export function getMessagingManifestAvailabilityContext(
  agent: MessagingAgentDescriptor | null | undefined,
  manifests: readonly ChannelManifest[],
): ChannelManifestAvailabilityContext {
  const name = typeof agent?.name === "string" ? agent.name.trim() : "";
  const id = name ? tryGetMessagingAgentId(agent, manifests) : null;
  return {
    agent: id,
    supportedChannelIds: name && id === null ? [] : null,
  };
}

export function formatSupportedMessagingAgentIds(
  supportedAgentIds: readonly MessagingAgentId[],
): string {
  return supportedAgentIds.length > 0 ? supportedAgentIds.join(", ") : "(none)";
}

export function resolveMessagingManifestSeed(
  manifests: readonly ChannelManifest[],
  existingChannels: readonly string[] | null | undefined,
  hasChannelConfiguredInputs: (manifest: ChannelManifest) => boolean,
  { includeAllExisting = false }: { readonly includeAllExisting?: boolean } = {},
): string[] {
  const seeded = new Set(
    manifests.filter(hasChannelConfiguredInputs).map((manifest) => manifest.id),
  );
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

/**
 * Return whether environment-backed inputs explicitly select a channel.
 *
 * Credentialed channels require every required input. Credentialless channels
 * such as WhatsApp have no required input, so any configured optional input is
 * the explicit signal that non-interactive onboarding should select them.
 */
export function hasMessagingManifestConfiguredInputs(
  manifest: ChannelManifest,
  resolveInput: MessagingInputResolver,
): boolean {
  const requiredInputs = manifest.inputs.filter((input) => input.required);
  if (requiredInputs.length > 0) {
    return hasMessagingManifestRequiredInputs(manifest, resolveInput);
  }
  return manifest.inputs.some((input) => hasResolvedInputValue(resolveInput(input)));
}

function hasResolvedInputValue(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
