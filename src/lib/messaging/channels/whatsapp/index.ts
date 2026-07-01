// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineMessagingChannel } from "../module";
import { whatsappManifest } from "./manifest";
import { resolveWhatsappTemplateReference } from "./template-resolver";

export const whatsappChannelModule = defineMessagingChannel({
  kind: "nemoclaw.messaging.channel",
  apiVersion: 1,
  id: "whatsapp",
  manifest: () => whatsappManifest,
  templates: () => [
    {
      namespace: "whatsapp",
      resolve: resolveWhatsappTemplateReference,
    },
  ],
});

export { whatsappManifest } from "./manifest";
