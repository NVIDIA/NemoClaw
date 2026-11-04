// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesSwitchyardRoutingIntent } from "../../src/lib/hermes-switchyard-routing";
import {
  type SwitchyardProviderBindings,
  validateSwitchyardProviderBindings,
} from "../../src/lib/hermes-switchyard-routing";
import { switchyardProviderDefinition } from "../../src/lib/onboard/switchyard/bindings";

/** Synthetic observations for configuration tests; lifecycle tests own actual adapter observation. */
export function switchyardBindingFixture(
  routing: HermesSwitchyardRoutingIntent,
): SwitchyardProviderBindings {
  const providers = [...new Set([routing.efficient.provider, routing.capable.provider])].map(
    (logicalProvider, index) => {
      const definition = switchyardProviderDefinition(logicalProvider);
      return {
        logicalProvider,
        providerName: `switchyard-test-${index}`,
        providerId: `provider-test-${index}`,
        resourceVersion: 1,
        profileId: definition.profileId,
        profileSha256: "0".repeat(64),
        endpointUrl: definition.endpoint,
        credentialEnv: definition.credentialEnv,
      };
    },
  );
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
      judge: { ...role("capable"), ...routing.judge },
    },
    routing,
  );
}
