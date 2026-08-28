// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requiredObservabilityPolicyPresets } from "./observability-policy-presets";
import { type WebSearchConfig, webSearchProviderForConfig } from "./policy-presets";

const { LOCAL_INFERENCE_POLICY_PROVIDERS } = require("./providers") as {
  LOCAL_INFERENCE_POLICY_PROVIDERS: string[];
};

/** Include every selected feature that adds a network policy requirement. */
export function requiredOnboardPolicyPresets(input: {
  readonly additionalPresets: readonly string[];
  readonly provider: string | null;
  readonly webSearchConfig: WebSearchConfig | null;
  readonly agentName: string | null | undefined;
  readonly observabilityEnabled: boolean;
  readonly hostLocalInferenceRouteOnly?: boolean;
}): string[] {
  const required = new Set(input.additionalPresets);
  if (
    input.provider &&
    !input.hostLocalInferenceRouteOnly &&
    LOCAL_INFERENCE_POLICY_PROVIDERS.includes(input.provider)
  ) {
    required.add("local-inference");
  }
  if (input.webSearchConfig) required.add(webSearchProviderForConfig(input.webSearchConfig));
  for (const preset of requiredObservabilityPolicyPresets(
    input.agentName,
    input.observabilityEnabled,
  )) {
    required.add(preset);
  }
  return [...required];
}

/** Pre-create hooks cannot inspect a policy until OpenShell has created it. */
export function createOnboardPolicyRequirementBindings(): {
  readonly preflightPolicyRequirements: (_requirements: unknown) => void;
  readonly revalidatePolicyRequirements: (_context: unknown, _operation: string) => void;
} {
  return {
    preflightPolicyRequirements() {},
    revalidatePolicyRequirements() {},
  };
}
