// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getStructuredConfigValue,
  type RenderedChannelConfigParser,
  structuredConfigKey,
} from "../rendered-config-parser-utils";

export const voiceclawRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    if (context.agentId !== "openclaw") return [];
    return [
      structuredConfigKey("telnyxConnectionId", "openclaw.json", [
        "plugins",
        "entries",
        "voice-call",
        "config",
        "telnyx",
        "connectionId",
      ]),
      structuredConfigKey("telnyxPublicKey", "openclaw.json", [
        "plugins",
        "entries",
        "voice-call",
        "config",
        "telnyx",
        "publicKey",
      ]),
      structuredConfigKey("telnyxFromNumber", "openclaw.json", [
        "plugins",
        "entries",
        "voice-call",
        "config",
        "fromNumber",
      ]),
      structuredConfigKey("publicUrl", "openclaw.json", [
        "plugins",
        "entries",
        "voice-call",
        "config",
        "publicUrl",
      ]),
    ];
  },

  getValue(key, source) {
    return getStructuredConfigValue(source, key.path);
  },
};
