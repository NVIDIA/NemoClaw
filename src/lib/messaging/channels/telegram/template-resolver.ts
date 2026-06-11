// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
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

const DEFAULT_PROXY_HOST = "10.200.0.1";
const DEFAULT_PROXY_PORT = "3128";

export const resolveTelegramTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  if (reference === "proxyUrl") return resolvedRenderTemplateReference(proxyUrl(context.env));
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

function proxyUrl(env: RenderTemplateContext["env"]): string {
  const host = nonEmptyString(env?.NEMOCLAW_PROXY_HOST) ?? DEFAULT_PROXY_HOST;
  const port = nonEmptyString(env?.NEMOCLAW_PROXY_PORT) ?? DEFAULT_PROXY_PORT;
  return `http://${host}:${port}`;
}
