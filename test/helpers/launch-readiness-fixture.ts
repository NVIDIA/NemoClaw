// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_GATEWAY_PORT } from "../../src/lib/core/ports";
import { resolveGatewayName } from "../../src/lib/onboard/gateway-binding";
import { fingerprintSandboxRecreateValue } from "../../src/lib/onboard/sandbox-recreate-transaction";

export const LAUNCH_READINESS_FIXTURE_POLICY = `version: 1
network_policies:
  fixture_api:
    name: Fixture API
    endpoints:
      - host: example.com
        port: 443
    binaries:
      - path: /usr/bin/curl
`;

export function launchReadinessRegistryFixture(sandboxId = "abc") {
  return {
    openshellDriver: "docker",
    openshellVersion: "0.0.16",
    gatewayName: resolveGatewayName(DEFAULT_GATEWAY_PORT),
    gatewayPort: DEFAULT_GATEWAY_PORT,
    lifecycleGeneration: "launch-readiness-fixture-generation",
    lifecycleLiveIdentityFingerprint: fingerprintSandboxRecreateValue(sandboxId),
  } as const;
}
