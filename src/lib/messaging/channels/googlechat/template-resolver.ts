// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyString,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

const DEFAULT_AUDIENCE_TYPE = "app-url";

// When appPrincipal is left blank we render this all-zeros discovery sentinel
// instead of dropping the key. It only matters for personal/standalone (add-on)
// accounts: on the first inbound DM, OpenClaw compares the token's real add-on
// principal against this value, they mismatch, and it logs
// `unexpected add-on principal: <N>` — surfacing <N>, the real appPrincipal to
// copy. Without a seeded value the log instead says `missing add-on principal
// binding` with no number, so "leave blank" would be a dead end. Inert for
// Google Workspace accounts: their inbound token issuer (chat@system…) is
// approved before appPrincipal is ever read, and all-zeros can never collide
// with a real Google-assigned principal.
const APP_PRINCIPAL_DISCOVERY_SENTINEL = "000000000000000000000";

export const resolveGooglechatTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  switch (reference) {
    case "googlechatConfig.audienceType":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "googlechatConfig.audienceType")) ??
          DEFAULT_AUDIENCE_TYPE,
      );
    case "googlechatConfig.audience":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "googlechatConfig.audience")),
      );
    case "googlechatConfig.appPrincipal":
      return resolvedRenderTemplateReference(
        nonEmptyString(stateValue(context, "googlechatConfig.appPrincipal")) ??
          APP_PRINCIPAL_DISCOVERY_SENTINEL,
      );
    default:
      break;
  }

  // DM allowlist normalization. `values` resolving to undefined drops the
  // `allowFrom` key; `dmPolicy` resolving to undefined drops `dm.policy`. When
  // both drop, the empty `dm` object is removed by the render engine and
  // OpenClaw falls back to its default (pairing) DM policy.
  const allowReference = reference.match(/^allowedIds[.]googlechat[.](values|dmPolicy)$/);
  if (!allowReference?.[1]) return undefined;
  const ids = allowedIds(context, "googlechat");
  switch (allowReference[1]) {
    case "values":
      return resolvedRenderTemplateReference(nonEmptyArray(ids));
    case "dmPolicy":
      return resolvedRenderTemplateReference(ids.length > 0 ? "allowlist" : undefined);
    default:
      return undefined;
  }
};
