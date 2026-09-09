// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildGatewayInferenceGetArgs,
  getSandboxInferenceConfig,
  parseGatewayInference,
  resolveAgentInferenceApi,
} from "../inference/config";
import {
  type CurrentGatewayRouteCompatibilityCheck,
  type CurrentGatewayRouteDiscoveryPreflight,
  checkGatewayRouteCompatibility as checkGatewayRouteCompatibilityForRegistry,
  preflightGatewayRouteDiscovery as preflightGatewayRouteDiscoveryForRegistry,
} from "../inference/gateway-route-compatibility";
import { listSandboxes } from "../state/registry";

type RunCaptureOpenshell = (args: string[], options?: { ignoreError?: boolean }) => string | null;

/** A gateway that cannot answer is distinct from one that answers with another route. */
export type InferenceRouteState = "matched" | "mismatched" | "unanswered";

/** Resolve the exact portable inference route used by managed clone preparation. */
export function resolveManagedStartupInferenceRoute(
  agentName: string,
  provider: string,
  model: string,
  preferredInferenceApi: string | null,
) {
  const api =
    agentName === "langchain-deepagents-code"
      ? "openai-completions"
      : resolveAgentInferenceApi(agentName, provider, preferredInferenceApi);
  return getSandboxInferenceConfig(model, provider, api);
}

export function createInferenceRouteHelpers(
  runCaptureOpenshell: RunCaptureOpenshell,
  listSandboxesFn: typeof listSandboxes = listSandboxes,
) {
  function verifyInferenceRoute(gatewayName: string, provider: string, model: string): void {
    const live = parseGatewayInference(
      runCaptureOpenshell(buildGatewayInferenceGetArgs(gatewayName), { ignoreError: true }),
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

  function readInferenceRouteState(
    gatewayName: string,
    provider: string,
    model: string,
  ): InferenceRouteState {
    const live = parseGatewayInference(
      runCaptureOpenshell(buildGatewayInferenceGetArgs(gatewayName), { ignoreError: true }),
    );
    if (!live) return "unanswered";
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
