// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifestRegistry } from "../manifest";
import { createChannelManifestRegistry } from "../manifest/registry.ts";
import { discordManifest } from "./discord/manifest.ts";
import { googlechatManifest } from "./googlechat/manifest.ts";
import { slackManifest } from "./slack/manifest.ts";
import { teamsManifest } from "./teams/manifest.ts";
import { telegramManifest } from "./telegram/manifest.ts";
import { wechatManifest } from "./wechat/manifest.ts";
import { whatsappManifest } from "./whatsapp/manifest.ts";

export { discordManifest } from "./discord/manifest.ts";
export { googlechatManifest } from "./googlechat/manifest.ts";
export { slackManifest } from "./slack/manifest.ts";
export { teamsManifest } from "./teams/manifest.ts";
export { telegramManifest } from "./telegram/manifest.ts";
export { wechatManifest } from "./wechat/manifest.ts";
export { whatsappManifest } from "./whatsapp/manifest.ts";

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
