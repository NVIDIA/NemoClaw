// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
import type { MessagingSerializableValue } from "../../manifest";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyCsv,
  nonEmptyString,
  parseBoolean,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

const DEFAULT_TELEGRAM_GROUP_POLICY = "open";
const TELEGRAM_GROUP_POLICIES = new Set(["open", "allowlist", "disabled"]);

export const resolveTelegramTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  if (reference === "telegramConfig.groupPolicy") {
    return resolvedRenderTemplateReference(telegramGroupPolicy(context));
  }
  if (reference === "telegramConfig.openclawGroups") {
    return resolvedRenderTemplateReference(telegramOpenClawGroups(context));
  }
  if (reference === "telegramConfig.requireMention") {
    return resolvedRenderTemplateReference(
      parseBoolean(stateValue(context, "telegramConfig.requireMention")),
    );
  }

  const allowedIdsReference = reference.match(/^allowedIds[.]telegram[.](values|csv|dmPolicy)$/);
  if (!allowedIdsReference?.[1]) return undefined;
  const ids = allowedIds(context, "telegram");
  switch (allowedIdsReference[1]) {
    case "values":
      return resolvedRenderTemplateReference(nonEmptyArray(ids));
    case "csv":
      return resolvedRenderTemplateReference(nonEmptyCsv(ids));
    case "dmPolicy":
      return resolvedRenderTemplateReference(ids.length > 0 ? "allowlist" : undefined);
    default:
      return undefined;
  }
};

function telegramGroupPolicy(context: RenderTemplateContext): string {
  const value = nonEmptyString(stateValue(context, "telegramConfig.groupPolicy"));
  return value && TELEGRAM_GROUP_POLICIES.has(value) ? value : DEFAULT_TELEGRAM_GROUP_POLICY;
}

function telegramOpenClawGroups(
  context: RenderTemplateContext,
): Record<string, MessagingSerializableValue> | undefined {
  if (telegramGroupPolicy(context) !== "open") return undefined;
  const requireMention = parseBoolean(stateValue(context, "telegramConfig.requireMention"));
  return requireMention === true ? { "*": { requireMention: true } } : undefined;
}
