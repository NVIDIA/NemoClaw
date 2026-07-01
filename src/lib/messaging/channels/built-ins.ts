// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifestRegistry } from "../manifest";
import { createChannelManifestRegistry } from "../manifest";
import { discordChannelModule, discordManifest } from "./discord";
import {
  assertMessagingChannelDiscovery,
  discoverMessagingChannelModules,
  type MessagingChannelModuleDiscoveryEntry,
} from "./discovery";
import { slackChannelModule, slackManifest } from "./slack";
import { teamsChannelModule, teamsManifest } from "./teams";
import { telegramChannelModule, telegramManifest } from "./telegram";
import { wechatChannelModule, wechatManifest } from "./wechat";
import { whatsappChannelModule, whatsappManifest } from "./whatsapp";

export { discordChannelModule, discordManifest } from "./discord";
export { slackChannelModule, slackManifest } from "./slack";
export { teamsChannelModule, teamsManifest } from "./teams";
export { telegramChannelModule, telegramManifest } from "./telegram";
export { wechatChannelModule, wechatManifest } from "./wechat";
export { whatsappChannelModule, whatsappManifest } from "./whatsapp";

const BUILT_IN_CHANNEL_ORDER = ["telegram", "discord", "wechat", "slack", "whatsapp", "teams"];

const BUILT_IN_CHANNEL_MODULE_ENTRIES: readonly MessagingChannelModuleDiscoveryEntry[] = [
  {
    id: "telegram",
    source: "src/lib/messaging/channels/telegram",
    load: () => telegramChannelModule,
  },
  { id: "discord", source: "src/lib/messaging/channels/discord", load: () => discordChannelModule },
  { id: "wechat", source: "src/lib/messaging/channels/wechat", load: () => wechatChannelModule },
  { id: "slack", source: "src/lib/messaging/channels/slack", load: () => slackChannelModule },
  {
    id: "whatsapp",
    source: "src/lib/messaging/channels/whatsapp",
    load: () => whatsappChannelModule,
  },
  { id: "teams", source: "src/lib/messaging/channels/teams", load: () => teamsChannelModule },
] as const;

export function discoverBuiltInMessagingChannelModules() {
  return assertMessagingChannelDiscovery(
    discoverMessagingChannelModules(BUILT_IN_CHANNEL_MODULE_ENTRIES, {
      order: BUILT_IN_CHANNEL_ORDER,
    }),
  );
}

export const BUILT_IN_CHANNEL_MODULES = discoverBuiltInMessagingChannelModules();

export const BUILT_IN_CHANNEL_MANIFESTS = BUILT_IN_CHANNEL_MODULES.map((module) =>
  module.manifest(),
);

export function createBuiltInChannelManifestRegistry(): ChannelManifestRegistry {
  return createChannelManifestRegistry(BUILT_IN_CHANNEL_MANIFESTS);
}
