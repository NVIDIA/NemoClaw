// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel, type MessagingPolicyContribution } from "../module";
import type { TelegramHookOptions } from "./hooks";
import { telegramManifest } from "./manifest";
import { resolveTelegramTemplateReference } from "./template-resolver";

const telegramPolicyContributions = [
  {
    preset: "telegram",
    agent: "openclaw",
    sourceRoot: __dirname,
    source: "policy/openclaw.yaml",
  },
  {
    preset: "telegram",
    agent: "hermes",
    sourceRoot: __dirname,
    source: "policy/hermes.yaml",
  },
] as const satisfies readonly MessagingPolicyContribution[];

export const telegramChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "telegram",
  manifest: () => telegramManifest,
  policies: () => telegramPolicyContributions,
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
