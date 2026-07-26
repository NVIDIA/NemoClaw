// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CurrentGatewayRouteCompatibilityCheck,
  type CurrentGatewayRouteDiscoveryPreflight,
  formatGatewayRouteConflict,
  type GatewayInferenceRoute,
  type GatewayRouteDiscoveryConstraints,
  isAdvisoryGatewayRouteConflict,
} from "../../../inference/gateway-route-compatibility";

export interface ProviderInferenceRouteContainmentDeps {
  checkGatewayRouteCompatibility: CurrentGatewayRouteCompatibilityCheck;
  preflightGatewayRouteDiscovery: CurrentGatewayRouteDiscoveryPreflight;
  error(message: string): void;
  exitProcess(code: number): never;
}

export type ProviderInferenceProbeRoute = Omit<GatewayInferenceRoute, "model"> & {
  model: string | null;
};

function unconstrainedGatewayRouteDiscovery(): GatewayRouteDiscoveryConstraints {
  return {
    requiredModel: null,
    requiredEndpointUrl: null,
    requiredInferenceApi: null,
  };
}

export function assertProviderInferenceRouteCompatible(
  deps: ProviderInferenceRouteContainmentDeps,
  gatewayName: string,
  sandboxName: string | null,
  route: GatewayInferenceRoute,
): void {
  const compatibility = deps.checkGatewayRouteCompatibility({ gatewayName, sandboxName, route });
  if (!compatibility.ok) {
    if (isAdvisoryGatewayRouteConflict(compatibility)) return;
    deps.error(`  Error: ${formatGatewayRouteConflict(compatibility)}`);
    deps.exitProcess(1);
  }
}

/** Reject structurally unsafe peer metadata, then exact-check complete route identities. */
export function guardProviderInferenceRouteSelection(
  deps: ProviderInferenceRouteContainmentDeps,
  gatewayName: string,
  sandboxName: string | null,
  route: ProviderInferenceProbeRoute,
): GatewayRouteDiscoveryConstraints {
  const model = typeof route.model === "string" && route.model.trim() ? route.model : null;
  const preflight = deps.preflightGatewayRouteDiscovery({
    gatewayName,
    sandboxName,
    route: { ...route, model },
  });
  if (!preflight.ok) {
    if (isAdvisoryGatewayRouteConflict(preflight.result)) {
      return unconstrainedGatewayRouteDiscovery();
    }
    deps.error(`  Error: ${formatGatewayRouteConflict(preflight.result)}`);
    deps.exitProcess(1);
  }
  const provider = typeof route.provider === "string" ? route.provider.trim() : "";
  const completeCustomRoute =
    !["compatible-endpoint", "compatible-anthropic-endpoint"].includes(provider) ||
    (typeof route.endpointUrl === "string" &&
      route.endpointUrl.trim().length > 0 &&
      typeof route.preferredInferenceApi === "string" &&
      route.preferredInferenceApi.trim().length > 0);
  if (model && completeCustomRoute) {
    assertProviderInferenceRouteCompatible(deps, gatewayName, sandboxName, { ...route, model });
  }
  return unconstrainedGatewayRouteDiscovery();
}
