// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  envConfigKey,
  getEnvConfigValue,
  getStructuredConfigValue,
  type RenderedChannelConfigParser,
  structuredConfigKey,
} from "../rendered-config-parser-utils";

export const teamsRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    if (context.agentId === "openclaw") {
      return [
        structuredConfigKey("appId", "openclaw.json", ["channels", "msteams", "appId"]),
        structuredConfigKey("tenantId", "openclaw.json", ["channels", "msteams", "tenantId"]),
        structuredConfigKey("allowedUsers", "openclaw.json", ["channels", "msteams", "allowFrom"]),
        structuredConfigKey("webhookPort", "openclaw.json", [
          "channels",
          "msteams",
          "webhook",
          "port",
        ]),
        structuredConfigKey("requireMention", "openclaw.json", [
          "channels",
          "msteams",
          "requireMention",
        ]),
      ];
    }
    if (context.agentId === "hermes") {
      return [
        envConfigKey("appId", "~/.hermes/.env", "TEAMS_CLIENT_ID"),
        envConfigKey("tenantId", "~/.hermes/.env", "TEAMS_TENANT_ID"),
        envConfigKey("allowedUsers", "~/.hermes/.env", "TEAMS_ALLOWED_USERS"),
        envConfigKey("webhookPort", "~/.hermes/.env", "TEAMS_PORT"),
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
