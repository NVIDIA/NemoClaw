// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyCsv,
  nonEmptyString,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

const DEFAULT_WHATSAPP_MODE = "self-chat";

export const resolveWhatsappTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  if (reference === "whatsappConfig.mode") {
    return resolvedRenderTemplateReference(whatsappMode(context));
  }

  const allowedIdsReference = reference.match(/^allowedIds[.]whatsapp[.](values|csv|dmPolicy)$/);
  if (!allowedIdsReference?.[1]) return undefined;
  const ids = allowedIds(context, "whatsapp");
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

// The compiler drops a stored value outside the input's validValues, so an
// unusable mode arrives here as undefined. Render the mode the Hermes adapter
// already defaults to rather than dropping the line, so the sealed .env states
// which mode the bridge runs.
function whatsappMode(context: RenderTemplateContext): string {
  return nonEmptyString(stateValue(context, "whatsappConfig.mode")) ?? DEFAULT_WHATSAPP_MODE;
}
