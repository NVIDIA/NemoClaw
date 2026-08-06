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
const WHATSAPP_MODES = new Set([DEFAULT_WHATSAPP_MODE, "bot"]);

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

// The compiler applies the input's validValues, but a rebuild renders from the
// persisted plan, and both persistence paths carry a stored value through
// unchecked: normalizeFullInputs copies `value` verbatim, and
// inputReferenceFromManifest copies `persisted.value` onto the manifest spec.
// Re-check here so a stale or hand-edited registry entry cannot start the bridge
// in a mode it cannot serve. Render the adapter's own default rather than
// dropping the line, so the sealed .env states which mode the bridge runs.
function whatsappMode(context: RenderTemplateContext): string {
  const value = nonEmptyString(stateValue(context, "whatsappConfig.mode"));
  return value && WHATSAPP_MODES.has(value) ? value : DEFAULT_WHATSAPP_MODE;
}
