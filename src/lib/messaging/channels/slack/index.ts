// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel, type MessagingPolicyContribution } from "../module";
import type { SlackHookOptions } from "./hooks";
import { slackManifest } from "./manifest";
import { resolveSlackTemplateReference } from "./template-resolver";

const slackPolicyContributions = [
  {
    preset: "slack",
    agent: "openclaw",
    sourceRoot: __dirname,
    source: "policy/openclaw.yaml",
  },
  {
    preset: "slack",
    agent: "hermes",
    sourceRoot: __dirname,
    source: "policy/hermes.yaml",
  },
] as const satisfies readonly MessagingPolicyContribution[];

export const slackChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "slack",
  manifest: () => slackManifest,
  policies: () => slackPolicyContributions,
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
