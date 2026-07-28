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
  const pathByReference: Readonly<Record<string, string>> = {
    "voiceclaw.telnyxConnectionId": "voiceclaw.telnyxConnectionId",
    "voiceclaw.telnyxPublicKey": "voiceclaw.telnyxPublicKey",
    "voiceclaw.telnyxFromNumber": "voiceclaw.telnyxFromNumber",
    "voiceclaw.telnyxToNumber": "voiceclaw.telnyxToNumber",
    "voiceclaw.publicUrl": "voiceclaw.publicUrl",
    "voiceclaw.webhookPort": "voiceclaw.webhookPort",
  };
  const statePath = pathByReference[reference];
  if (!statePath) return undefined;
  const value = nonEmptyString(stateValue(context, statePath));
  if (reference === "voiceclaw.webhookPort") {
    return resolvedRenderTemplateReference(value ? Number(value) : undefined);
  }
  return resolvedRenderTemplateReference(value);
};
