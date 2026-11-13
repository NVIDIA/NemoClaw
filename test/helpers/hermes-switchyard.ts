// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type HermesSwitchyardRoutingIntent,
  type SwitchyardProviderBindings,
  switchyardClientProfile,
  switchyardJudgeSelection,
  switchyardPhysicalProviders,
  validateSwitchyardProviderBindings,
} from "../../src/lib/hermes-switchyard-routing.ts";
import { NVIDIA_HOSTED_NATIVE_PROFILE_ID } from "../../src/lib/inference/native-nvidia/contract.ts";
import { hostedNativeProvider } from "../../src/lib/inference/native-provider/agent-config.ts";

/** Synthetic observations for configuration tests; lifecycle tests own actual adapter observation. */
export function switchyardBindingFixture(
  routing: HermesSwitchyardRoutingIntent,
): SwitchyardProviderBindings {
  const providers = switchyardPhysicalProviders(routing).map((logicalProvider, index) => {
    const client = switchyardClientProfile(logicalProvider);
    return {
      logicalProvider,
      providerName: `switchyard-test-${index}`,
      providerId: `provider-test-${index}`,
      resourceVersion: 1,
      profileId:
        logicalProvider === "nvidia-prod"
          ? NVIDIA_HOSTED_NATIVE_PROFILE_ID
          : hostedNativeProvider(logicalProvider)?.profileId,
      profileSha256: "0".repeat(64),
      endpointUrl: client.baseUrl,
      credentialEnv: client.apiKeyEnv,
    };
  });
  const role = (key: "efficient" | "capable") => ({
    providerId: providers.find((p) => p.logicalProvider === routing[key].provider)?.providerId,
    model: routing[key].model,
  });
  return validateSwitchyardProviderBindings(
    {
      schemaVersion: 1,
      providers,
      efficient: role("efficient"),
      capable: role("capable"),
      judge: {
        providerId: providers.find(
          (p) => p.logicalProvider === switchyardJudgeSelection(routing).provider,
        )?.providerId,
        model: switchyardJudgeSelection(routing).model,
        mode: routing.judge.mode,
        target: routing.judge.target,
      },
    },
    routing,
  );
}
