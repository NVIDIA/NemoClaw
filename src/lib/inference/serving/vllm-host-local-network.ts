// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

import { dockerCapture } from "../../adapters/docker/local-model-runtime";
export function validateManagedVllmBridgeHost(value: string): string {
  const [first, second] = value.split(".").map(Number);
  const privateIpv4 =
    net.isIP(value) === 4 &&
    (first === 10 ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168));
  if (!privateIpv4) {
    throw new Error("Managed host-local vLLM requires one private OpenShell bridge address");
  }
  return value;
}

function isManagedVllmBridgeHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    validateManagedVllmBridgeHost(value);
    return true;
  } catch {
    return false;
  }
}

export function resolveManagedVllmBridgeHost(
  capture: typeof dockerCapture = dockerCapture,
  dockerEnv?: Record<string, string>,
): string {
  const raw = capture(
    ["network", "inspect", "--format", "{{json .IPAM.Config}}", "openshell-docker"],
    { ...(dockerEnv ? { env: dockerEnv } : {}), ignoreError: true, timeout: 10_000 },
  ).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Managed host-local vLLM could not inspect the OpenShell bridge");
  }
  const gateways = Array.isArray(parsed)
    ? parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const gateway = (entry as Record<string, unknown>).Gateway;
        return isManagedVllmBridgeHost(gateway) ? [gateway] : [];
      })
    : [];
  if (gateways.length !== 1) {
    throw new Error("Managed host-local vLLM requires one private OpenShell bridge address");
  }
  return validateManagedVllmBridgeHost(gateways[0]!);
}
