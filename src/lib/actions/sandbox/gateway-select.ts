// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { getKnownSandboxTargetGatewayName } from "./gateway-target";

export type GatewaySelectRunner = typeof runOpenshell;

export function selectSandboxOwningGateway(
  sandboxName: string,
  run: GatewaySelectRunner = runOpenshell,
): string | null {
  const targetGatewayName = getKnownSandboxTargetGatewayName(sandboxName);
  if (!targetGatewayName) return null;
  run(["gateway", "select", targetGatewayName], {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  return targetGatewayName;
}
