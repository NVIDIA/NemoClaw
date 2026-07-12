// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
import { normalizeWechatIlinkBaseUrl } from "./ilink-base-url";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyCsv,
  nonEmptyString,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

export const resolveWechatTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  const wechatConfig = reference.match(/^wechatConfig[.](accountId|baseUrl|userId)$/);
  if (wechatConfig?.[1]) {
    if (wechatConfig[1] === "baseUrl") {
      return resolvedRenderTemplateReference(
        normalizeWechatIlinkBaseUrl(stateValue(context, "wechatConfig.baseUrl")),
      );
    }
    return resolvedRenderTemplateReference(
      nonEmptyString(stateValue(context, "wechatConfig." + wechatConfig[1])),
    );
  }

  const allowedIdsReference = reference.match(/^allowedIds[.]wechat[.](values|csv|dmPolicy)$/);
  if (!allowedIdsReference?.[1]) return undefined;
  const ids = wechatAllowedIds(context);
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

function wechatAllowedIds(context: RenderTemplateContext): string[] {
  const ids = allowedIds(context, "wechat");
  const userId = nonEmptyString(stateValue(context, "wechatConfig.userId"));
  return userId && !ids.includes(userId) ? [userId, ...ids] : ids;
}
