// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellInferenceRouteMutationResult,
  SetOpenShellInferenceRouteRequest,
} from "../../adapters/openshell/inference-route";
import {
  checkGatewayRouteCompatibility,
  GatewayRouteConflictError,
  isAdvisoryGatewayRouteConflict,
} from "../../inference/gateway-route-compatibility";
import { resolveRegisteredRuntimeProvider } from "../../onboard/runtime-provider/selection";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "../../onboard/env";
import type { SandboxEntry } from "../../state/registry";
import { listPublishedSandboxesAcrossGatewayRoots } from "../../state/registry/cross-port";

const CONNECT_ROUTE_MUTATION_TIMEOUT_MS = 30_000;

export type ConnectInferenceRouteMutationResult = OpenShellInferenceRouteMutationResult;

export function connectInferenceRouteMutationRequest(
  gatewayName: string,
  provider: string,
  model: string,
): SetOpenShellInferenceRouteRequest {
  return {
    target: { kind: "named", gatewayName },
    route: { provider, model },
    verification: "skip",
    timeoutMs: CONNECT_ROUTE_MUTATION_TIMEOUT_MS,
    ...(["compatible-endpoint", "ollama-local", "vllm-local"].includes(provider)
      ? { verificationTimeoutSeconds: LOCAL_INFERENCE_TIMEOUT_SECS }
      : {}),
  };
}

/** Identify the legacy cluster gateway without branching on managed provider IDs. */
export function sandboxUsesLegacyClusterGateway(sandbox: SandboxEntry | null): boolean {
  const driver = sandbox?.openshellDriver;
  if (!driver) return true;
  const provider = resolveRegisteredRuntimeProvider(driver);
  if (provider) return provider.gateway.launcher !== "nemoclaw";
  return driver !== "vm";
}

function sandboxGatewayRouteCompatibility(
  sandboxName: string,
  sb: SandboxEntry,
  gatewayName: string,
  sandboxes: readonly SandboxEntry[],
) {
  return checkGatewayRouteCompatibility({
    gatewayName,
    sandboxName,
    route: sb,
    sandboxes,
  });
}

export function canSandboxGatewayRouteRealign(
  sandboxName: string,
  sb: SandboxEntry,
  gatewayName: string,
  sandboxes: readonly SandboxEntry[] = listPublishedSandboxesAcrossGatewayRoots(),
): boolean {
  const result = sandboxGatewayRouteCompatibility(sandboxName, sb, gatewayName, sandboxes);
  return result.ok || isAdvisoryGatewayRouteConflict(result);
}

export function assertSandboxGatewayRouteCompatible(
  sandboxName: string,
  sb: SandboxEntry,
  gatewayName: string,
): void {
  const result = sandboxGatewayRouteCompatibility(
    sandboxName,
    sb,
    gatewayName,
    listPublishedSandboxesAcrossGatewayRoots(),
  );
  if (!result.ok && !isAdvisoryGatewayRouteConflict(result)) {
    throw new GatewayRouteConflictError(result);
  }
}
