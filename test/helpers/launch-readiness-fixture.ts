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

export const LAUNCH_READINESS_PAIRING_QUALIFICATION_OUTPUT =
  `__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=${JSON.stringify({
    deviceIdentitySha256: "a".repeat(64),
    pairingStateSha256: "b".repeat(64),
    requiredRoles: ["operator"],
    requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
  })}`;

export function launchReadinessRegistryFixture(sandboxId = "abc") {
  return {
    agent: "openclaw",
    agentVersion: "2026.7.1",
    openshellDriver: "docker",
    openshellVersion: "0.0.16",
    gatewayName: resolveGatewayName(DEFAULT_GATEWAY_PORT),
    gatewayPort: DEFAULT_GATEWAY_PORT,
    lifecycleGeneration: "launch-readiness-fixture-generation",
    lifecycleLiveIdentityFingerprint: fingerprintSandboxRecreateValue(sandboxId),
  } as const;
}
