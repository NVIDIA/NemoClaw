// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifestRegistry } from "../manifest";
import { createChannelManifestRegistry } from "../manifest";
import { discordChannelModule, discordManifest } from "./discord";
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

export const BUILT_IN_CHANNEL_MODULES = [
  telegramChannelModule,
  discordChannelModule,
  wechatChannelModule,
  slackChannelModule,
  whatsappChannelModule,
  teamsChannelModule,
] as const;

export const BUILT_IN_CHANNEL_MANIFESTS = BUILT_IN_CHANNEL_MODULES.map((module) =>
  module.manifest(),
);

export function createBuiltInChannelManifestRegistry(): ChannelManifestRegistry {
  return createChannelManifestRegistry(BUILT_IN_CHANNEL_MANIFESTS);
}
