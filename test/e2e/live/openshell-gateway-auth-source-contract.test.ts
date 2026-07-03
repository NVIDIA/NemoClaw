// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import { runOpenShellGatewayAuthSourceContractScenario } from "./openshell-gateway-auth-source-contract-helpers.ts";

const CONTRACT_ENABLED =
  shouldRunLiveE2E() || process.env.NEMOCLAW_LIVE_OPENSHELL_GATEWAY_AUTH_CONTRACT === "1";
const liveTest = CONTRACT_ENABLED ? test : test.skip;
const LIVE_TIMEOUT_MS = 8 * 60_000;
const OPENSHELL_GATEWAY_AUTH_CONTRACT_VERSION = "0.0.72";

liveTest(
  `OpenShell ${OPENSHELL_GATEWAY_AUTH_CONTRACT_VERSION} Docker-driver gateway auth uses NemoClaw mTLS plus sandbox JWT`,
  { timeout: LIVE_TIMEOUT_MS },
  runOpenShellGatewayAuthSourceContractScenario,
);
