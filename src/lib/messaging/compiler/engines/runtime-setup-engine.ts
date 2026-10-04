// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  ChannelRuntimeNodePreloadSpec,
  MessagingAgentId,
  SandboxMessagingChannelPlan,
  SandboxMessagingRuntimeEnvAliasPlan,
  SandboxMessagingRuntimeNodePreloadPlan,
  SandboxMessagingRuntimeSecretScanPlan,
  SandboxMessagingRuntimeSetupPlan,
} from "../../manifest";

const PRELOAD_SOURCE_PREFIX = "/usr/local/lib/nemoclaw/preloads/";
const PRELOAD_TARGET_PREFIX = "/tmp/nemoclaw-";
const NODE_PRELOAD_MODULE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function planRuntimeSetup(
  manifests: readonly ChannelManifest[],
  agent: MessagingAgentId,
  channels: readonly SandboxMessagingChannelPlan[],
): SandboxMessagingRuntimeSetupPlan {
  const activeChannelIds = new Set(
    channels
      .filter((channel) => channel.active && !channel.disabled)
      .map((channel) => channel.channelId),
  );
  const nodePreloads: SandboxMessagingRuntimeNodePreloadPlan[] = [];
  const envAliases: SandboxMessagingRuntimeEnvAliasPlan[] = [];
  const secretScans: SandboxMessagingRuntimeSecretScanPlan[] = [];

  for (const manifest of manifests) {
    if (!activeChannelIds.has(manifest.id)) continue;
    const runtime = manifest.runtime?.[agent];
    if (!runtime) continue;
    nodePreloads.push(
      ...(runtime.nodePreloads ?? []).map((entry) => resolveNodePreload(manifest, entry)),
    );
    envAliases.push(
      ...(runtime.envAliases ?? []).map((entry) => ({
        channelId: manifest.id,
        ...entry,
      })),
    );
    secretScans.push(
      ...(runtime.secretScans ?? []).map((entry) => ({
        channelId: manifest.id,
        ...entry,
      })),
    );
  }

  return { nodePreloads, envAliases, secretScans };
}

function resolveNodePreload(
  manifest: ChannelManifest,
  entry: ChannelRuntimeNodePreloadSpec,
): SandboxMessagingRuntimeNodePreloadPlan {
  if (!NODE_PRELOAD_MODULE_PATTERN.test(entry.module)) {
    throw new Error(
      `Channel manifest '${manifest.id}' declares invalid runtime node preload module '${entry.module}'.`,
    );
  }
  return {
    channelId: manifest.id,
    ...entry,
    source: `${PRELOAD_SOURCE_PREFIX}${entry.module}.js`,
    target: `${PRELOAD_TARGET_PREFIX}${entry.module}.js`,
  };
}
