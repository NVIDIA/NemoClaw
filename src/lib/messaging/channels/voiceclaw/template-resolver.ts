// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type BuiltInRenderTemplateResolver,
  nonEmptyString,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

export const resolveVoiceClawTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  if (reference !== "voiceclaw.audioBridgeUrl") return undefined;
  return resolvedRenderTemplateReference(
    nonEmptyString(stateValue(context, "voiceclaw.audioBridgeUrl")),
  );
};
