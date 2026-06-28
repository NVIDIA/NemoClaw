// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelConfigInputSpec,
  ChannelManifest,
  MessagingAgentId,
  MessagingChannelId,
} from "./types";

export interface ChannelManifestAvailabilityContext {
  readonly agent?: MessagingAgentId | null;
  readonly supportedChannelIds?: readonly MessagingChannelId[] | null;
}

export class ChannelManifestRegistry {
  private readonly manifests = new Map<MessagingChannelId, ChannelManifest>();

  constructor(manifests: readonly ChannelManifest[] = []) {
    for (const manifest of manifests) {
      this.register(manifest);
    }
  }

  register(manifest: ChannelManifest): this {
    if (this.manifests.has(manifest.id)) {
      throw new Error(`Duplicate channel manifest id '${manifest.id}'`);
    }
    assertDiagnosticContractValid(manifest);

    this.manifests.set(manifest.id, manifest);
    return this;
  }

  get(channelId: MessagingChannelId): ChannelManifest | undefined {
    return this.manifests.get(channelId);
  }

  list(): ChannelManifest[] {
    return Array.from(this.manifests.values());
  }

  listAvailable(ctx: ChannelManifestAvailabilityContext = {}): ChannelManifest[] {
    const supportedChannelIds = Array.isArray(ctx.supportedChannelIds)
      ? new Set(ctx.supportedChannelIds)
      : null;

    return this.list().filter((manifest) => {
      if (ctx.agent && !manifest.supportedAgents.includes(ctx.agent)) {
        return false;
      }
      if (supportedChannelIds && !supportedChannelIds.has(manifest.id)) {
        return false;
      }
      return true;
    });
  }
}

export function createChannelManifestRegistry(
  manifests: readonly ChannelManifest[] = [],
): ChannelManifestRegistry {
  return new ChannelManifestRegistry(manifests);
}

export function asMessagingAgent(name: string | null | undefined): MessagingAgentId | null {
  return name === "openclaw" || name === "hermes" ? name : null;
}

function assertDiagnosticContractValid(manifest: ChannelManifest): void {
  const supportedAgents = new Set<MessagingAgentId>(manifest.supportedAgents);
  for (const input of manifest.inputs) {
    if (input.kind !== "config") {
      assertSafeToPrintOnlyOnConfig(manifest.id, input);
      continue;
    }
    assertValueDisplayKeysAllowed(manifest.id, input);
    assertAgentApplicabilitySupported(manifest.id, input, supportedAgents);
  }
}

function assertSafeToPrintOnlyOnConfig(
  channelId: MessagingChannelId,
  input: ChannelManifest["inputs"][number],
): void {
  if ((input as { safeToPrintInDiagnostics?: boolean }).safeToPrintInDiagnostics === true) {
    throw new Error(
      `Channel manifest '${channelId}' input '${input.id}' is not kind 'config' yet declares safeToPrintInDiagnostics=true`,
    );
  }
}

function assertValueDisplayKeysAllowed(
  channelId: MessagingChannelId,
  input: ChannelConfigInputSpec,
): void {
  if (!input.valueDisplay) return;
  const allowed = new Set(input.validValues ?? []);
  for (const key of Object.keys(input.valueDisplay)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Channel manifest '${channelId}' input '${input.id}' valueDisplay key '${key}' is not in validValues`,
      );
    }
  }
}

function assertAgentApplicabilitySupported(
  channelId: MessagingChannelId,
  input: ChannelConfigInputSpec,
  supportedAgents: ReadonlySet<MessagingAgentId>,
): void {
  if (!input.agentApplicability) return;
  for (const agent of input.agentApplicability) {
    if (!supportedAgents.has(agent)) {
      throw new Error(
        `Channel manifest '${channelId}' input '${input.id}' agentApplicability '${agent}' is not in supportedAgents`,
      );
    }
  }
}
