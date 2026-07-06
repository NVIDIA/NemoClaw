// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CurrentGatewayRouteCompatibilityCheck,
  formatGatewayRouteConflict,
  type GatewayInferenceRoute,
} from "../../../inference/gateway-route-compatibility";

export interface ProviderInferenceRouteContainmentDeps {
  checkGatewayRouteCompatibility: CurrentGatewayRouteCompatibilityCheck;
  error(message: string): void;
  exitProcess(code: number): never;
}

export function assertProviderInferenceRouteCompatible(
  deps: ProviderInferenceRouteContainmentDeps,
  gatewayName: string,
  sandboxName: string | null,
  route: GatewayInferenceRoute,
): void {
  const compatibility = deps.checkGatewayRouteCompatibility({ gatewayName, sandboxName, route });
  if (!compatibility.ok) {
    deps.error(`  Error: ${formatGatewayRouteConflict(compatibility)}`);
    deps.exitProcess(1);
  }
}
