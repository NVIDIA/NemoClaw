// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest, MessagingAgentId, MessagingChannelId } from "./types";

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
    const supportedChannelIds =
      ctx.supportedChannelIds && ctx.supportedChannelIds.length > 0
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
