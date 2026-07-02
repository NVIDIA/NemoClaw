// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  envConfigKey,
  getEnvConfigValue,
  getStructuredConfigValue,
  type RenderedChannelConfigParser,
  type RenderedConfigSource,
  type RenderedConfigVisibilityKey,
  structuredConfigKey,
} from "../rendered-config-parser-utils";

const OPENCLAW_CHANNELS_KEY = "openclawAllowedChannels";

export const slackRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    if (context.agentId === "openclaw") {
      return [
        structuredConfigKey("allowedUsers", "openclaw.json", [
          "channels",
          "slack",
          "accounts",
          "default",
          "allowFrom",
        ]),
        structuredConfigKey(
          "allowedChannels",
          "openclaw.json",
          ["channels", "slack", "accounts", "default", "channels"],
          OPENCLAW_CHANNELS_KEY,
        ),
      ];
    }
    if (context.agentId === "hermes") {
      return [
        envConfigKey("allowedUsers", "~/.hermes/.env", "SLACK_ALLOWED_USERS"),
        envConfigKey("allowedChannels", "~/.hermes/.env", "SLACK_ALLOWED_CHANNELS"),
      ];
    }
    return [];
  },

  getValue(key, source) {
    if (key.key === OPENCLAW_CHANNELS_KEY) return slackAllowedChannelIds(source, key);
    return key.kind === "env"
      ? getEnvConfigValue(source, key.envKey)
      : getStructuredConfigValue(source, key.path);
  },
};

function slackAllowedChannelIds(
  source: RenderedConfigSource,
  key: RenderedConfigVisibilityKey,
): string[] | undefined {
  const value = getStructuredConfigValue(source, key.path);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const channelIds = Object.keys(value).filter((channelId) => channelId !== "*");
  return channelIds.length > 0 ? channelIds : undefined;
}
