// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveDiscordTemplateReference } from "./discord/template-resolver";
import { resolveSlackTemplateReference } from "./slack/template-resolver";
import { resolveTelegramTemplateReference } from "./telegram/template-resolver";
import type { BuiltInRenderTemplateResolver } from "./template-resolver-utils";
import { resolveWechatTemplateReference } from "./wechat/template-resolver";
import { resolveWhatsappTemplateReference } from "./whatsapp/template-resolver";

const BUILT_IN_TEMPLATE_REFERENCE_RESOLVERS: readonly BuiltInRenderTemplateResolver[] = [
  resolveTelegramTemplateReference,
  resolveDiscordTemplateReference,
  resolveWechatTemplateReference,
  resolveSlackTemplateReference,
  resolveWhatsappTemplateReference,
];

export function createBuiltInRenderTemplateResolver(): BuiltInRenderTemplateResolver {
  return (reference, context) => {
    for (const resolver of BUILT_IN_TEMPLATE_REFERENCE_RESOLVERS) {
      const resolved = resolver(reference, context);
      if (resolved) return resolved;
    }
    return undefined;
  };
}
