// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  envConfigKey,
  getEnvConfigValue,
  getStructuredConfigValue,
  type RenderedChannelConfigParser,
  structuredConfigKey,
} from "../rendered-config-parser-utils";

export const telegramRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    if (context.agentId === "openclaw") {
      return [
        structuredConfigKey("allowedIds", "openclaw.json", [
          "channels",
          "telegram",
          "accounts",
          "default",
          "allowFrom",
        ]),
        structuredConfigKey("groupPolicy", "openclaw.json", [
          "channels",
          "telegram",
          "accounts",
          "default",
          "groupPolicy",
        ]),
      ];
    }
    if (context.agentId === "hermes") {
      return [
        envConfigKey("allowedIds", "~/.hermes/.env", "TELEGRAM_ALLOWED_USERS"),
        structuredConfigKey("requireMention", "~/.hermes/config.yaml", [
          "telegram",
          "require_mention",
        ]),
      ];
    }
    return [];
  },

  getValue(key, source) {
    return key.kind === "env"
      ? getEnvConfigValue(source, key.envKey)
      : getStructuredConfigValue(source, key.path);
  },
};
