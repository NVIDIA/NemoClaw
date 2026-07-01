// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel, type MessagingPolicyContribution } from "../module";
import { whatsappManifest } from "./manifest";
import { resolveWhatsappTemplateReference } from "./template-resolver";

const whatsappPolicyContributions = [
  {
    preset: "whatsapp",
    agent: "openclaw",
    sourceRoot: __dirname,
    source: "policy/openclaw.yaml",
  },
  {
    preset: "whatsapp",
    agent: "hermes",
    sourceRoot: __dirname,
    source: "policy/hermes.yaml",
  },
] as const satisfies readonly MessagingPolicyContribution[];

export const whatsappChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "whatsapp",
  manifest: () => whatsappManifest,
  policies: () => whatsappPolicyContributions,
  templates: () => [
    {
      namespace: "whatsapp",
      resolve: resolveWhatsappTemplateReference,
    },
  ],
});

export { whatsappManifest } from "./manifest";
