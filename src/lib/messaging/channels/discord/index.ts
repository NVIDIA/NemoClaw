// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel } from "../module";
import type { DiscordHookOptions } from "./hooks";
import { discordManifest } from "./manifest";
import { resolveDiscordTemplateReference } from "./template-resolver";

export const discordChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "discord",
  manifest: () => discordManifest,
  hooks: (options?: unknown) => {
    const { createDiscordHookRegistrations } = require("./hooks") as typeof import("./hooks");
    return createDiscordHookRegistrations((options ?? {}) as DiscordHookOptions);
  },
  templates: () => [
    {
      namespace: "discord",
      resolve: resolveDiscordTemplateReference,
    },
  ],
});

export { discordManifest } from "./manifest";
