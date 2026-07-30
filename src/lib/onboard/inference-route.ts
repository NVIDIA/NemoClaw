// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseGatewayInference } from "../inference/config";
import {
  type CurrentGatewayRouteCompatibilityCheck,
  type CurrentGatewayRouteDiscoveryPreflight,
  checkGatewayRouteCompatibility as checkGatewayRouteCompatibilityForRegistry,
  preflightGatewayRouteDiscovery as preflightGatewayRouteDiscoveryForRegistry,
} from "../inference/gateway-route-compatibility";
import { listSandboxes } from "../state/registry";

type RunCaptureOpenshell = (args: string[], options?: { ignoreError?: boolean }) => string | null;

export function createInferenceRouteHelpers(
  runCaptureOpenshell: RunCaptureOpenshell,
  listSandboxesFn: typeof listSandboxes = listSandboxes,
) {
  function verifyInferenceRoute(gatewayName: string, provider: string, model: string): void {
    const live = parseGatewayInference(
      runCaptureOpenshell(["inference", "get", "-g", gatewayName], { ignoreError: true }),
    );
    if (!live) {
      console.error("  OpenShell inference route was not configured.");
      process.exit(1);
    }
    if (live.provider !== provider || live.model !== model) {
      console.error(
        `  OpenShell inference route does not match provider '${provider}' and model '${model}'.`,
      );
      process.exit(1);
    }
  }

  function isInferenceRouteReady(gatewayName: string, provider: string, model: string): boolean {
    const live = parseGatewayInference(
      runCaptureOpenshell(["inference", "get", "-g", gatewayName], { ignoreError: true }),
    );
    return Boolean(live && live.provider === provider && live.model === model);
  }

  const checkGatewayRouteCompatibility: CurrentGatewayRouteCompatibilityCheck = (request) =>
    checkGatewayRouteCompatibilityForRegistry({
      ...request,
      sandboxes: listSandboxesFn().sandboxes,
    });

  const preflightGatewayRouteDiscovery: CurrentGatewayRouteDiscoveryPreflight = (request) =>
    preflightGatewayRouteDiscoveryForRegistry({
      ...request,
      sandboxes: listSandboxesFn().sandboxes,
    });

  return {
    verifyInferenceRoute,
    isInferenceRouteReady,
    checkGatewayRouteCompatibility,
    preflightGatewayRouteDiscovery,
  };
}
