// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../manifest";
import { BUILT_IN_CHANNEL_MANIFESTS } from "./built-ins";
import { discordRenderedConfigParser } from "./discord/rendered-config-parser";
import type { RenderedChannelConfigParser } from "./rendered-config-parser-utils";
import { slackRenderedConfigParser } from "./slack/rendered-config-parser";
import { teamsRenderedConfigParser } from "./teams/rendered-config-parser";
import { telegramRenderedConfigParser } from "./telegram/rendered-config-parser";
import { wechatRenderedConfigParser } from "./wechat/rendered-config-parser";
import { whatsappRenderedConfigParser } from "./whatsapp/rendered-config-parser";

export * from "./rendered-config-parser-utils";

const BUILT_IN_RENDERED_CONFIG_PARSERS: ReadonlyMap<string, RenderedChannelConfigParser> = new Map(
  BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => [
    manifest.id,
    renderedConfigParserForBuiltInManifest(manifest),
  ]),
);

export function getBuiltInRenderedConfigParser(
  channelId: string,
): RenderedChannelConfigParser | null {
  return BUILT_IN_RENDERED_CONFIG_PARSERS.get(channelId) ?? null;
}

function renderedConfigParserForBuiltInManifest(
  manifest: ChannelManifest,
): RenderedChannelConfigParser {
  switch (manifest.id) {
    case "discord":
      return discordRenderedConfigParser;
    case "slack":
      return slackRenderedConfigParser;
    case "teams":
      return teamsRenderedConfigParser;
    case "telegram":
      return telegramRenderedConfigParser;
    case "wechat":
      return wechatRenderedConfigParser;
    case "whatsapp":
      return whatsappRenderedConfigParser;
    default:
      throw new Error(`missing rendered config parser for built-in channel '${manifest.id}'`);
  }
}
