// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel } from "../module";
import type { TelegramHookOptions } from "./hooks";
import { telegramManifest } from "./manifest";
import { resolveTelegramTemplateReference } from "./template-resolver";

export const telegramChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "telegram",
  manifest: () => telegramManifest,
  hooks: (options?: unknown) => {
    const { createTelegramHookRegistrations } = require("./hooks") as typeof import("./hooks");
    return createTelegramHookRegistrations((options ?? {}) as TelegramHookOptions);
  },
  templates: () => [
    {
      namespace: "telegram",
      resolve: resolveTelegramTemplateReference,
    },
  ],
});

export { telegramManifest } from "./manifest";
