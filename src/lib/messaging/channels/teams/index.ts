// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel, type MessagingPolicyContribution } from "../module";
import type { TeamsHookOptions } from "./hooks";
import { teamsManifest } from "./manifest";
import { resolveTeamsTemplateReference } from "./template-resolver";

const teamsPolicyContributions = [
  {
    preset: "teams",
    agent: "openclaw",
    sourceRoot: __dirname,
    source: "policy/openclaw.yaml",
  },
  {
    preset: "teams",
    agent: "hermes",
    sourceRoot: __dirname,
    source: "policy/hermes.yaml",
  },
] as const satisfies readonly MessagingPolicyContribution[];

export const teamsChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "teams",
  manifest: () => teamsManifest,
  policies: () => teamsPolicyContributions,
  hooks: (options?: unknown) => {
    const { createTeamsHookRegistrations } = require("./hooks") as typeof import("./hooks");
    return createTeamsHookRegistrations((options ?? {}) as TeamsHookOptions);
  },
  templates: () => [
    {
      namespace: "teams",
      resolve: resolveTeamsTemplateReference,
    },
  ],
});

export { teamsManifest } from "./manifest";
