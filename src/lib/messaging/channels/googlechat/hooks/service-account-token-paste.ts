// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential, prompt, saveCredential } from "../../../../credentials/store";
import type { ChannelHookOutputSpec } from "../../../manifest";
import {
  createTokenPasteHook,
  resolveManifestTokenPasteField,
  type TokenPasteField,
  type TokenPasteHookOptions,
} from "../../../hooks/common/token-paste";
import type { MessagingHookRegistration } from "../../../hooks/types";
import { googlechatManifest } from "../manifest";

export const GOOGLECHAT_TOKEN_PASTE_HOOK_HANDLER_ID = "googlechat.tokenPaste";

/**
 * Reject a pasted service-account key that is not valid JSON, so a truncated
 * paste is re-prompted here instead of aborting onboarding later at token-minting.
 * (The manifest regex already checks the required key names are present.)
 */
export function serviceAccountJsonError(token: string): string | null {
  try {
    JSON.parse(token);
    return null;
  } catch {
    return "Service account JSON could not be parsed";
  }
}

// Google Chat's only secret is the service-account JSON. Take the field the
// generic token-paste hook would build from the manifest and attach a structural
// validator a regex cannot express, keeping the JSON check out of the shared hook.
function resolveGooglechatTokenPasteField(
  _channelId: string,
  output: ChannelHookOutputSpec,
): TokenPasteField | null {
  const field = resolveManifestTokenPasteField(googlechatManifest, output);
  if (!field || output.id !== "serviceAccount") return field;
  return { ...field, validate: serviceAccountJsonError };
}

/**
 * Google Chat runs its own token-paste hook (not the shared `common.tokenPaste`)
 * only to inject the service-account validator. It carries the same default
 * injections the common hook uses (see defaultCommonHookOptions) so the paste
 * prompt behaves identically; keep them in sync. Options override for tests.
 */
export function createGooglechatTokenPasteHookRegistration(
  options: TokenPasteHookOptions = {},
): MessagingHookRegistration {
  return {
    id: GOOGLECHAT_TOKEN_PASTE_HOOK_HANDLER_ID,
    handler: createTokenPasteHook({
      getCredential,
      saveCredential,
      prompt,
      log: (message) => console.log(message),
      ...options,
      resolveField: resolveGooglechatTokenPasteField,
    }),
  };
}
