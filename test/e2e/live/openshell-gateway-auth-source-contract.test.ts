// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildDockerDriverGatewayLaunch } from "../../../dist/lib/onboard/docker-driver-gateway-launch";
import { ensureDockerDriverGatewayLocalTlsBundle } from "../../../dist/lib/onboard/docker-driver-gateway-local-tls";
import { test } from "../fixtures/e2e-test.ts";
import { OPENSHELL_V0106_QUALIFICATION } from "../fixtures/openshell-v0106-qualification.ts";
import { runOpenShellGatewayAuthSourceContractScenario } from "./openshell-gateway-auth-source-contract-helpers.ts";

const LIVE_TIMEOUT_MS = 8 * 60_000;
const OPENSHELL_GATEWAY_AUTH_CONTRACT_VERSION =
  process.env.NEMOCLAW_CANDIDATE_VERSION ?? OPENSHELL_V0106_QUALIFICATION.version;

test(
  `OpenShell ${OPENSHELL_GATEWAY_AUTH_CONTRACT_VERSION} Docker-driver gateway auth uses NemoClaw mTLS plus sandbox JWT`,
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm gateway and Docker prerequisites",
        "verify the exact OpenShell TLS server-name source boundary",
        "launch the mTLS and JWT-protected gateway",
        "probe unauthenticated and mTLS-only access",
        "probe sandbox JWT authorization boundaries",
      ],
    },
  },
  ({ artifacts, cleanup, host, progress, skip }) =>
    runOpenShellGatewayAuthSourceContractScenario(
      { artifacts, cleanup, host, progress, skip },
      {
        buildDockerDriverGatewayLaunch,
        ensureDockerDriverGatewayLocalTlsBundle,
      },
    ),
);
