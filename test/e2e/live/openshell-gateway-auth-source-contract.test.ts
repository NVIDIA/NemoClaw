// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildDockerDriverGatewayLaunch } from "../../../dist/lib/onboard/docker-driver-gateway-launch";
import { ensureDockerDriverGatewayLocalTlsBundle } from "../../../dist/lib/onboard/docker-driver-gateway-local-tls";
import { test } from "../fixtures/e2e-test.ts";
import { runOpenShellGatewayAuthSourceContractScenario } from "./openshell-gateway-auth-source-contract-helpers.ts";

const LIVE_TIMEOUT_MS = 8 * 60_000;
const OPENSHELL_GATEWAY_AUTH_CONTRACT_VERSION = "0.0.72";

test(
  `OpenShell ${OPENSHELL_GATEWAY_AUTH_CONTRACT_VERSION} Docker-driver gateway auth uses NemoClaw mTLS plus sandbox JWT`,
  { timeout: LIVE_TIMEOUT_MS },
  (fixtures) =>
    runOpenShellGatewayAuthSourceContractScenario(fixtures, {
      buildDockerDriverGatewayLaunch,
      ensureDockerDriverGatewayLocalTlsBundle,
    }),
);
