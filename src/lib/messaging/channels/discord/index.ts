// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel, type MessagingPolicyContribution } from "../module";
import type { DiscordHookOptions } from "./hooks";
import { discordManifest } from "./manifest";
import { resolveDiscordTemplateReference } from "./template-resolver";

const discordPolicyContributions = [
  {
    preset: "discord",
    agent: "openclaw",
    sourceRoot: __dirname,
    source: "policy/openclaw.yaml",
  },
  {
    preset: "discord",
    agent: "hermes",
    sourceRoot: __dirname,
    source: "policy/hermes.yaml",
  },
] as const satisfies readonly MessagingPolicyContribution[];

export const discordChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "discord",
  manifest: () => discordManifest,
  policies: () => discordPolicyContributions,
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
