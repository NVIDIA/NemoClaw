// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  checkGatewayRouteCompatibility,
  GatewayRouteConflictError,
  isAdvisoryProviderModelRouteConflict,
} from "../../inference/gateway-route-compatibility";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "../../onboard/env";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";

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
  sandboxes: readonly SandboxEntry[] = registry.listSandboxes().sandboxes,
): boolean {
  const result = sandboxGatewayRouteCompatibility(sandboxName, sb, gatewayName, sandboxes);
  return result.ok || isAdvisoryProviderModelRouteConflict(result);
}

export function buildGatewayInferenceGetArgs(gatewayName: string): string[] {
  return ["inference", "get", "-g", gatewayName];
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
    registry.listSandboxes().sandboxes,
  );
  if (!result.ok && !isAdvisoryProviderModelRouteConflict(result)) {
    throw new GatewayRouteConflictError(result);
  }
}
