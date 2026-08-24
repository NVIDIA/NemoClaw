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
  readonly exit?: (code: number) => void;
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
  const errorLog = deps.log ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const result = ensureEndpointlessProviderProfile({
    profileId: OPENAI_GATEWAY_PROVIDER_TYPE,
    inferenceCapable: true,
    profilePath: endpointlessProviderProfilePath(
      deps.root ?? REPOSITORY_ROOT,
      OPENAI_GATEWAY_PROVIDER_TYPE,
    ),
    runOpenshell: deps.runOpenshell,
  });
  if (result.ok) return;

  errorLog(
    `\n  ✗ Failed to register the '${OPENAI_GATEWAY_PROVIDER_TYPE}' inference provider profile with OpenShell (${result.reason}).`,
  );
  const diagnostic = result.diagnostic.slice(0, 500);
  if (diagnostic) errorLog(`    ${diagnostic}`);
  errorLog(
    "    Without it the sandbox supervisor rejects the provider environment as unclassified.",
  );
  errorLog("    Update OpenShell with scripts/install-openshell.sh and re-run onboarding.");
  exit(1);
}
