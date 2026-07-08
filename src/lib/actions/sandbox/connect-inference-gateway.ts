// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertGatewayRouteCompatibility } from "../../inference/gateway-route-compatibility";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "../../onboard/env";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";

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
  assertGatewayRouteCompatibility({
    gatewayName,
    sandboxName,
    route: sb,
    sandboxes: registry.listSandboxes().sandboxes,
  });
}
