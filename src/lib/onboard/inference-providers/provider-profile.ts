// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  endpointlessProviderProfilePath,
  ensureEndpointlessProviderProfile,
  type EndpointlessProviderProfileRunner,
} from "../../messaging/provider-profile";

/** OpenShell provider type registered for every OpenAI-surface inference route. */
export const OPENAI_GATEWAY_PROVIDER_TYPE = "openai";

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

export type OpenAiProviderProfileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly messages: readonly string[] };

/**
 * Result-returning variant for callers that report failure through an
 * `UpsertProviderResult` instead of an injected exit, such as the recovered
 * gateway-credential reuse path.
 */
export function checkOpenAiInferenceProviderProfile(deps: {
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly root?: string;
}): OpenAiProviderProfileCheck {
  const result = ensureEndpointlessProviderProfile({
    profileId: OPENAI_GATEWAY_PROVIDER_TYPE,
    inferenceCapable: true,
    profilePath: endpointlessProviderProfilePath(
      deps.root ?? REPOSITORY_ROOT,
      OPENAI_GATEWAY_PROVIDER_TYPE,
    ),
    runOpenshell: deps.runOpenshell,
  });
  if (result.ok) return { ok: true };

  if (result.reason === "import-failed") {
    return {
      ok: false,
      messages: [
        `\n  ✗ OpenShell could not import the checked-in '${OPENAI_GATEWAY_PROVIDER_TYPE}' inference provider profile.`,
        "    Confirm the NemoClaw checkout is complete, then re-run onboarding.",
      ],
    };
  }
  if (result.reason === "export-failed") {
    return {
      ok: false,
      messages: [
        `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' already exists but could not be read for validation.`,
        "    Repair or remove that profile, then re-run onboarding.",
      ],
    };
  }
  return {
    ok: false,
    messages: [
      `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless inference contract.`,
      "    Remove the conflicting profile, then re-run onboarding.",
    ],
  };
}
