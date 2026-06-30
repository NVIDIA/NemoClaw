// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { discordRenderedConfigParser } from "./discord/rendered-config-parser";
import type { RenderedChannelConfigParser } from "./rendered-config-parser-utils";
import { slackRenderedConfigParser } from "./slack/rendered-config-parser";
import { teamsRenderedConfigParser } from "./teams/rendered-config-parser";
import { telegramRenderedConfigParser } from "./telegram/rendered-config-parser";
import { wechatRenderedConfigParser } from "./wechat/rendered-config-parser";
import { whatsappRenderedConfigParser } from "./whatsapp/rendered-config-parser";

export * from "./rendered-config-parser-utils";

const BUILT_IN_RENDERED_CONFIG_PARSERS: Readonly<Record<string, RenderedChannelConfigParser>> = {
  discord: discordRenderedConfigParser,
  slack: slackRenderedConfigParser,
  teams: teamsRenderedConfigParser,
  telegram: telegramRenderedConfigParser,
  wechat: wechatRenderedConfigParser,
  whatsapp: whatsappRenderedConfigParser,
};

export function getBuiltInRenderedConfigParser(
  channelId: string,
): RenderedChannelConfigParser | null {
  return BUILT_IN_RENDERED_CONFIG_PARSERS[channelId] ?? null;
}
