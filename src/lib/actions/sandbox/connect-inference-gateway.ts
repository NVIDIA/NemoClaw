// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  checkGatewayRouteCompatibility,
  GatewayRouteConflictError,
  isAdvisoryGatewayRouteConflict,
} from "../../inference/gateway-route-compatibility";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "../../onboard/env";
import { resolveRegisteredRuntimeProvider } from "../../onboard/runtime-provider/selection";
import type { SandboxEntry } from "../../state/registry";
import { listPublishedSandboxesAcrossGatewayRoots } from "../../state/registry/cross-port";

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

export function buildGatewayInferenceSetArgs(
  gatewayName: string,
  provider: string,
  model: string,
): string[] {
  const args = [
    "inference",
    "set",
    "-g",
    gatewayName,
    "--provider",
    provider,
    "--model",
    model,
    "--no-verify",
  ];
  if (["compatible-endpoint", "ollama-local", "vllm-local"].includes(provider)) {
    args.push("--timeout", String(LOCAL_INFERENCE_TIMEOUT_SECS));
  }
  return args;
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
