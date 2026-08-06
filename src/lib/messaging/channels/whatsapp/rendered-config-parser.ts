// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  envConfigKey,
  getEnvConfigValue,
  type RenderedChannelConfigParser,
} from "../rendered-config-parser-utils";

export const whatsappRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    if (context.agentId !== "hermes") return [];
    // The mode decides whether an empty allowlist matters: bot rejects every
    // sender without one, self-chat never reads it. Surface both together.
    return [
      envConfigKey("mode", "~/.hermes/.env", "WHATSAPP_MODE"),
      envConfigKey("allowedIds", "~/.hermes/.env", "WHATSAPP_ALLOWED_USERS"),
    ];
  },

  getValue(key, source) {
    return getEnvConfigValue(source, key.envKey);
  },
};
