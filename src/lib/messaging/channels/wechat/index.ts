// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel } from "../module";
import type { WechatHookOptions } from "./hooks";
import { wechatManifest } from "./manifest";
import { resolveWechatTemplateReference } from "./template-resolver";

export const wechatChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "wechat",
  manifest: () => wechatManifest,
  hooks: (options?: unknown) => {
    const { createWechatHookRegistrations } = require("./hooks") as typeof import("./hooks");
    return createWechatHookRegistrations((options ?? {}) as WechatHookOptions);
  },
  templates: () => [
    {
      namespace: "wechat",
      resolve: resolveWechatTemplateReference,
    },
  ],
});

export { wechatManifest } from "./manifest";
