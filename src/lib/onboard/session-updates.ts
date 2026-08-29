// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxPolicyAuthority } from "../adapters/openshell/policy-authority";
import type { ServingProfileProvenance } from "../inference/serving/types";
import type { WebSearchConfig } from "../inference/web-search";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { HermesAuthMethod, SessionUpdates } from "../state/onboard-session";
import { normalizeToolDisclosure, type ToolDisclosure } from "../tool-disclosure";
import { normalizeReasoningEffort, type ReasoningEffort } from "./reasoning-mode";

export interface OnboardSessionUpdateInput {
  sandboxName?: string | null;
  provider?: string | null;
  model?: string | null;
  servingProfileProvenance?: ServingProfileProvenance | null;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  hermesAuthMethod?: HermesAuthMethod | string | null;
  preferredInferenceApi?: string | null;
  compatibleEndpointReasoning?: string | null;
  compatibleEndpointReasoningEffort?: string | null;
  nimContainer?: string | null;
  webSearchConfig?: WebSearchConfig | null;
  toolDisclosure?: ToolDisclosure | string;
  observabilityEnabled?: boolean;
  policyPresets?: string[] | null;
  policyAuthority?: SandboxPolicyAuthority | null;
  messagingPlan?: SandboxMessagingPlan | null;
  hermesToolGateways?: string[] | null;
  /** Ephemeral vLLM checkpoint proof consumed by Station provider binding; never persisted. */
  stationExpressModelIdentity?: string;
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

// The recorded reasoning effort follows the same nullable contract, and an
// unrecognized value clears the recorded effort rather than persisting an
// effort the compatible endpoint never received (#7940).
function normalizeReasoningEffortUpdate(
  value: string | null | undefined,
): ReasoningEffort | null | undefined {
  return value === undefined ? undefined : normalizeReasoningEffort(value);
}

export function toSessionUpdates(updates: OnboardSessionUpdateInput = {}): SessionUpdates {
  const normalized: SessionUpdates = {};
  if (updates.sandboxName !== undefined)
    normalized.sandboxName = toNullableString(updates.sandboxName);
  if (updates.provider !== undefined) normalized.provider = toNullableString(updates.provider);
  if (updates.model !== undefined) normalized.model = toNullableString(updates.model);
  if (updates.servingProfileProvenance !== undefined) {
    normalized.servingProfileProvenance = updates.servingProfileProvenance;
  }
  if (updates.endpointUrl !== undefined)
    normalized.endpointUrl = toNullableString(updates.endpointUrl);
  if (updates.credentialEnv !== undefined)
    normalized.credentialEnv = toNullableString(updates.credentialEnv);
  if (updates.hermesAuthMethod !== undefined)
    normalized.hermesAuthMethod = normalizeHermesAuthMethod(updates.hermesAuthMethod);
  if (updates.preferredInferenceApi !== undefined) {
    normalized.preferredInferenceApi = toNullableString(updates.preferredInferenceApi);
  }
  if (updates.compatibleEndpointReasoning !== undefined) {
    normalized.compatibleEndpointReasoning = toNullableString(updates.compatibleEndpointReasoning);
  }
  if (updates.compatibleEndpointReasoningEffort !== undefined) {
    normalized.compatibleEndpointReasoningEffort = normalizeReasoningEffortUpdate(
      updates.compatibleEndpointReasoningEffort,
    );
  }
  if (updates.nimContainer !== undefined)
    normalized.nimContainer = toNullableString(updates.nimContainer);
  if (updates.webSearchConfig !== undefined) normalized.webSearchConfig = updates.webSearchConfig;
  if (updates.toolDisclosure !== undefined) {
    const toolDisclosure = normalizeToolDisclosure(updates.toolDisclosure);
    if (toolDisclosure) normalized.toolDisclosure = toolDisclosure;
  }
  if (typeof updates.observabilityEnabled === "boolean") {
    normalized.observabilityEnabled = updates.observabilityEnabled;
  }
  if (updates.policyPresets !== undefined) normalized.policyPresets = updates.policyPresets;
  if (updates.policyAuthority !== undefined) normalized.policyAuthority = updates.policyAuthority;
  if (updates.messagingPlan !== undefined) normalized.messagingPlan = updates.messagingPlan;
  if (updates.hermesToolGateways !== undefined)
    normalized.hermesToolGateways = updates.hermesToolGateways;
  if (updates.stationExpressModelIdentity !== undefined) {
    normalized.stationExpressModelIdentity = updates.stationExpressModelIdentity;
  }
  return normalized;
}
