// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel } from "../module";
import type { SlackHookOptions } from "./hooks";
import { slackManifest } from "./manifest";
import { resolveSlackTemplateReference } from "./template-resolver";

export const slackChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "slack",
  manifest: () => slackManifest,
  hooks: (options?: unknown) => {
    const { createSlackHookRegistrations } = require("./hooks") as typeof import("./hooks");
    return createSlackHookRegistrations((options ?? {}) as SlackHookOptions);
  },
  templates: () => [
    {
      namespace: "slack",
      resolve: resolveSlackTemplateReference,
    },
  ],
});

export { slackManifest } from "./manifest";
