// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { getKnownSandboxTargetGatewayName } from "./gateway-target";

export type GatewaySelectRunner = typeof runOpenshell;

export type GatewaySelectResult =
  | { outcome: "selected"; gatewayName: string }
  | { outcome: "failed"; gatewayName: string }
  | { outcome: "unregistered"; gatewayName: null };

export function selectSandboxOwningGateway(
  sandboxName: string,
  run: GatewaySelectRunner = runOpenshell,
): GatewaySelectResult {
  const targetGatewayName = getKnownSandboxTargetGatewayName(sandboxName);
  if (!targetGatewayName) return { outcome: "unregistered", gatewayName: null };
  const result = run(["gateway", "select", targetGatewayName], {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    return { outcome: "failed", gatewayName: targetGatewayName };
  }
  return { outcome: "selected", gatewayName: targetGatewayName };
}
