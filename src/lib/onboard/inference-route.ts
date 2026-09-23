// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSynchronousInferenceRouteObserver } from "../adapters/openshell/inference-route";
import {
  createSynchronousCliOpenShellInferenceRouteObserver,
  type CaptureOpenShellInferenceRouteSynchronously,
} from "../adapters/openshell/inference-route-cli";
export { resolveManagedStartupInferenceRoute } from "../inference/gateway/route-contract";
import {
  type CurrentGatewayRouteCompatibilityCheck,
  type CurrentGatewayRouteDiscoveryPreflight,
  checkGatewayRouteCompatibility as checkGatewayRouteCompatibilityForRegistry,
  preflightGatewayRouteDiscovery as preflightGatewayRouteDiscoveryForRegistry,
} from "../inference/gateway-route-compatibility";
import { listSandboxes } from "../state/registry";

/** A gateway that cannot answer is distinct from one that answers with another route. */
export type InferenceRouteState = "matched" | "mismatched" | "unanswered";

export function createInferenceRouteHelpers(
  inferenceRouteObserver: OpenShellSynchronousInferenceRouteObserver,
  listSandboxesFn: typeof listSandboxes = listSandboxes,
) {
  function verifyInferenceRoute(gatewayName: string, provider: string, model: string): void {
    const result = inferenceRouteObserver.observeInferenceRoute({
      target: { kind: "named", gatewayName },
    });
    if (!result.ok || result.value.state === "unconfigured") {
      console.error("  OpenShell inference route was not configured.");
      process.exit(1);
    }
    const live = result.value.route;
    if (live.provider !== provider || live.model !== model) {
      console.error(
        `  OpenShell inference route does not match provider '${provider}' and model '${model}'.`,
      );
      process.exit(1);
    }
  }

  function readInferenceRouteState(
    gatewayName: string,
    provider: string,
    model: string,
  ): InferenceRouteState {
    const result = inferenceRouteObserver.observeInferenceRoute({
      target: { kind: "named", gatewayName },
    });
    if (!result.ok || result.value.state === "unconfigured") return "unanswered";
    const live = result.value.route;
    return live.provider === provider && live.model === model ? "matched" : "mismatched";
  }

  function isInferenceRouteReady(gatewayName: string, provider: string, model: string): boolean {
    return readInferenceRouteState(gatewayName, provider, model) === "matched";
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
    readInferenceRouteState,
    checkGatewayRouteCompatibility,
    preflightGatewayRouteDiscovery,
  };
}

/** Compose onboarding route decisions with the synchronous CLI observer. */
export function createCliInferenceRouteHelpers(
  capture: CaptureOpenShellInferenceRouteSynchronously,
  listSandboxesFn: typeof listSandboxes = listSandboxes,
) {
  return createInferenceRouteHelpers(
    createSynchronousCliOpenShellInferenceRouteObserver(capture),
    listSandboxesFn,
  );
}
