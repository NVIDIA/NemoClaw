// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingSerializableValue } from "../../manifest";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyCsv,
  parseList,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

export const resolveSlackTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  if (reference === "slackConfig.allowedChannels.csv") {
    return resolvedRenderTemplateReference(nonEmptyCsv(slackAllowedChannels(context)));
  }

  const allowedIdsReference = reference.match(
    /^allowedIds[.]slack[.](values|csv|dmPolicy|groupPolicy|channels)$/,
  );
  if (!allowedIdsReference?.[1]) return undefined;
  const ids = allowedIds(context, "slack");
  switch (allowedIdsReference[1]) {
    case "values":
      return resolvedRenderTemplateReference(nonEmptyArray(ids));
    case "csv":
      return resolvedRenderTemplateReference(nonEmptyCsv(ids));
    case "dmPolicy":
      return resolvedRenderTemplateReference(ids.length > 0 ? "allowlist" : undefined);
    case "groupPolicy":
      return resolvedRenderTemplateReference(
        ids.length > 0 || slackAllowedChannels(context).length > 0 ? "allowlist" : undefined,
      );
    case "channels":
      return resolvedRenderTemplateReference(slackChannelConfig(context, ids));
    default:
      return undefined;
  }
};

function slackChannelConfig(
  context: Parameters<BuiltInRenderTemplateResolver>[1],
  users: readonly string[],
): Record<string, MessagingSerializableValue> | undefined {
  const allowedChannels = slackAllowedChannels(context);
  const entry: Record<string, MessagingSerializableValue> = {
    enabled: true,
    requireMention: true,
    ...(users.length > 0 ? { users: [...users] } : {}),
  };
  if (allowedChannels.length > 0) {
    return Object.fromEntries(allowedChannels.map((channelId) => [channelId, { ...entry }]));
  }
  return users.length > 0 ? { "*": entry } : undefined;
}

function slackAllowedChannels(context: Parameters<BuiltInRenderTemplateResolver>[1]): string[] {
  return parseList(stateValue(context, "slackConfig.allowedChannels"));
}
