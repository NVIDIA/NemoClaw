// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { MessagingChannelConfig } from "../messaging-channel-config";
import type { HermesAuthMethod, SessionUpdates } from "../state/onboard-session";

export interface OnboardSessionUpdateInput {
  sandboxName?: string | null;
  provider?: string | null;
  model?: string | null;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  hermesAuthMethod?: HermesAuthMethod | string | null;
  preferredInferenceApi?: string | null;
  nimContainer?: string | null;
  webSearchConfig?: WebSearchConfig | null;
  policyPresets?: string[] | null;
  messagingChannels?: string[] | null;
  messagingChannelConfig?: MessagingChannelConfig | null;
  hermesToolGateways?: string[] | null;
}

// Preserve the nullable contract end-to-end: `null` means "clear this
// field on the persisted session", `undefined` means "leave unchanged".
function toNullableString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value;
}

function normalizeHermesAuthMethod(value: string | null | undefined): HermesAuthMethod | null {
  return value === "oauth" || value === "api_key" ? value : null;
}

export function toSessionUpdates(updates: OnboardSessionUpdateInput = {}): SessionUpdates {
  const normalized: SessionUpdates = {};
  if (updates.sandboxName !== undefined)
    normalized.sandboxName = toNullableString(updates.sandboxName);
  if (updates.provider !== undefined) normalized.provider = toNullableString(updates.provider);
  if (updates.model !== undefined) normalized.model = toNullableString(updates.model);
  if (updates.endpointUrl !== undefined)
    normalized.endpointUrl = toNullableString(updates.endpointUrl);
  if (updates.credentialEnv !== undefined)
    normalized.credentialEnv = toNullableString(updates.credentialEnv);
  if (updates.hermesAuthMethod !== undefined)
    normalized.hermesAuthMethod = normalizeHermesAuthMethod(updates.hermesAuthMethod);
  if (updates.preferredInferenceApi !== undefined) {
    normalized.preferredInferenceApi = toNullableString(updates.preferredInferenceApi);
  }
  if (updates.nimContainer !== undefined)
    normalized.nimContainer = toNullableString(updates.nimContainer);
  if (updates.webSearchConfig !== undefined) normalized.webSearchConfig = updates.webSearchConfig;
  if (updates.policyPresets !== undefined) normalized.policyPresets = updates.policyPresets;
  if (updates.messagingChannels !== undefined)
    normalized.messagingChannels = updates.messagingChannels;
  if (updates.messagingChannelConfig !== undefined) {
    normalized.messagingChannelConfig = updates.messagingChannelConfig;
  }
  if (updates.hermesToolGateways !== undefined)
    normalized.hermesToolGateways = updates.hermesToolGateways;
  return normalized;
}
