// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getStructuredConfigValue,
  type RenderedChannelConfigParser,
  structuredConfigKey,
} from "../rendered-config-parser-utils";

// Google Chat is OpenClaw-only; all operator-facing config renders under
// `channels.googlechat` in openclaw.json. The `serviceAccountFile` is a start-gate
// sentinel (not user config) and the outbound bearer is gateway-minted, so neither
// is surfaced here.
export const googlechatRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    if (context.agentId !== "openclaw") return [];
    return [
      structuredConfigKey("audienceType", "openclaw.json", [
        "channels",
        "googlechat",
        "audienceType",
      ]),
      structuredConfigKey("audience", "openclaw.json", ["channels", "googlechat", "audience"]),
      structuredConfigKey("appPrincipal", "openclaw.json", [
        "channels",
        "googlechat",
        "appPrincipal",
      ]),
      structuredConfigKey("allowFrom", "openclaw.json", [
        "channels",
        "googlechat",
        "dm",
        "allowFrom",
      ]),
    ];
  },

  getValue(key, source) {
    return getStructuredConfigValue(source, key.path);
  },
};
