// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyCsv,
  nonEmptyString,
  parseList,
  parseBoolean,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

const DEFAULT_TEAMS_WEBHOOK_PORT = 3978;

export const resolveTeamsTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  switch (reference) {
    case "teamsConfig.appId":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "teamsConfig.appId")),
      );
    case "teamsConfig.tenantId":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "teamsConfig.tenantId")),
      );
    case "teamsConfig.webhookPort":
      return resolvedRenderTemplateReference(teamsWebhookPort(context));
    case "teamsConfig.requireMention":
      return resolvedRenderTemplateReference(
        parseBoolean(stateValue(context, "teamsConfig.requireMention")),
      );
    case "teamsConfig.groupPolicy":
      return resolvedRenderTemplateReference(teamsGroupPolicy(context));
    case "teamsConfig.groupAllowFrom":
      return resolvedRenderTemplateReference(nonEmptyArray(teamsGroupAllowFrom(context)));
    default:
      break;
  }

  const allowedIdsReference = reference.match(/^allowedIds[.]teams[.](values|csv|dmPolicy)$/);
  if (!allowedIdsReference?.[1]) return undefined;
  const ids = allowedIds(context, "teams");
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

function teamsWebhookPort(context: RenderTemplateContext): number {
  const raw = nonEmptyString(stateValue(context, "teamsConfig.webhookPort"));
  if (!raw) return DEFAULT_TEAMS_WEBHOOK_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      "Microsoft Teams webhook port must be an integer TCP port between 1 and 65535.",
    );
  }
  return port;
}

function teamsGroupAllowFrom(context: RenderTemplateContext): string[] {
  if (rawTeamsGroupPolicy(context) !== "allowlist") return [];
  return parseList(stateValue(context, "teamsConfig.groupAllowFrom"));
}

function teamsGroupPolicy(context: RenderTemplateContext): string {
  const raw = rawTeamsGroupPolicy(context);
  if (raw === "allowlist") {
    return teamsGroupAllowFrom(context).length > 0 ? "allowlist" : "open";
  }
  return raw;
}

function rawTeamsGroupPolicy(context: RenderTemplateContext): string {
  return nonEmptyString(stateValue(context, "teamsConfig.groupPolicy")) ?? "open";
}
