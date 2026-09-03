// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  checkOpenAiInferenceProviderProfile,
  type EndpointlessProviderProfileRunner,
} from "../../adapters/openshell/provider-profile-registration";

export { OPENAI_GATEWAY_PROVIDER_TYPE } from "../../adapters/openshell/provider-profile-registration";

export type InferenceProviderProfileDeps = {
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly root?: string;
  readonly log?: (message: string) => void;
  readonly exit?: (code: number) => never;
};

/**
 * Register the endpointless `openai` provider profile before an OpenAI-surface
 * inference provider is created.
 *
 * invalidState: OpenShell ships built-in profiles for `nvidia` and `anthropic`
 * but not for `openai`, while still accepting `provider create --type openai`
 * without one. Its static-credential resolver then hands the sandbox a
 * credential key it cannot classify, so the supervisor rejects the entire
 * provider environment and revokes static credentials on every refresh
 * (`CONFIG:FAIL_CLOSED ... unclassified credential key`, repeating). See #9895.
 * sourceBoundary: OpenShell owns provider-environment classification and
 * rejects a snapshot atomically.
 * whyNotSourceFix: NemoClaw must remain compatible with the pinned OpenShell
 * release, so it declares the missing profile contract before registering.
 * removalCondition: drop once the pinned OpenShell ships a built-in `openai`
 * provider profile.
 */
export function ensureOpenAiInferenceProviderProfile(deps: InferenceProviderProfileDeps): void {
  const check = checkOpenAiInferenceProviderProfile(deps);
  if (check.ok) return;
  const errorLog = deps.log ?? console.error;
  for (const message of check.messages) errorLog(message);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  return exit(1);
}
