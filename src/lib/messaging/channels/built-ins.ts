// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifestRegistry } from "../manifest";
import { createChannelManifestRegistry } from "../manifest";
import { discordManifest } from "./discord/manifest";
import { googlechatManifest } from "./googlechat/manifest";
import { slackManifest } from "./slack/manifest";
import { teamsManifest } from "./teams/manifest";
import { telegramManifest } from "./telegram/manifest";
import { wechatManifest } from "./wechat/manifest";
import { whatsappManifest } from "./whatsapp/manifest";

export { discordManifest } from "./discord/manifest";
export { googlechatManifest } from "./googlechat/manifest";
export { slackManifest } from "./slack/manifest";
export { teamsManifest } from "./teams/manifest";
export { telegramManifest } from "./telegram/manifest";
export { wechatManifest } from "./wechat/manifest";
export { whatsappManifest } from "./whatsapp/manifest";

export const BUILT_IN_CHANNEL_MANIFESTS = [
  telegramManifest,
  discordManifest,
  wechatManifest,
  slackManifest,
  whatsappManifest,
  teamsManifest,
  googlechatManifest,
] as const;

export function createBuiltInChannelManifestRegistry(): ChannelManifestRegistry {
  return createChannelManifestRegistry(BUILT_IN_CHANNEL_MANIFESTS);
}
