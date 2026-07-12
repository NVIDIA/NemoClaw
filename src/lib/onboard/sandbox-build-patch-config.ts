// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type MessagingChannelConfig,
  readMessagingChannelConfigFromEnv,
} from "../messaging-channel-config";
import { listMessagingConfigEnvMetadata } from "../messaging/channels";

export type SandboxBuildPatchConfig = {
  messagingChannelConfig: MessagingChannelConfig | null;
};

export type SandboxBuildPatchConfigDeps = {
  readMessagingChannelConfigFromEnv?(env?: NodeJS.ProcessEnv): MessagingChannelConfig | null;
};

export type PrepareSandboxBuildPatchConfigInput = {
  configuredMessagingChannels?: readonly string[];
  env?: NodeJS.ProcessEnv;
  deps?: SandboxBuildPatchConfigDeps;
};

export function prepareSandboxBuildPatchConfig({
  configuredMessagingChannels = [],
  env = process.env,
  deps = {},
}: PrepareSandboxBuildPatchConfigInput): SandboxBuildPatchConfig {
  // Dockerfile messaging rendering is sourced from the manifest plan. Reading
  // env config here validates operator-provided channel config before build;
  // durable replay lives in SandboxEntry.messaging.plan.
  const messagingChannelConfig = (
    deps.readMessagingChannelConfigFromEnv ?? readMessagingChannelConfigFromEnv
  )(env);
  return {
    messagingChannelConfig: filterMessagingChannelConfig(
      messagingChannelConfig,
      configuredMessagingChannels,
    ),
  };
}

function filterMessagingChannelConfig(
  config: MessagingChannelConfig | null,
  configuredMessagingChannels: readonly string[],
): MessagingChannelConfig | null {
  if (!config) return null;
  const configured = new Set(configuredMessagingChannels);
  if (configured.size === 0) return null;
  const allowedKeys = new Set(
    listMessagingConfigEnvMetadata()
      .filter((metadata) => configured.has(metadata.channelId))
      .map((metadata) => metadata.envKey),
  );
  const filtered = Object.fromEntries(
    Object.entries(config).filter(([key]) => allowedKeys.has(key)),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}
