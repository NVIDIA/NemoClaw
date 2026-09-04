// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const E2E_GATEWAY_RUNTIMES = ["docker", "podman"] as const;
export type E2eGatewayRuntime = (typeof E2E_GATEWAY_RUNTIMES)[number];
export const E2E_RUNTIME_AGNOSTIC = "agnostic" as const;
export type E2eGatewayRuntimeSupport = readonly E2eGatewayRuntime[] | typeof E2E_RUNTIME_AGNOSTIC;
export type E2eRuntimeProvider = E2eGatewayRuntime | "none";

export function e2eGatewayRuntime(value: string | undefined): E2eGatewayRuntime {
  const runtime = value ?? "docker";
  if (!E2E_GATEWAY_RUNTIMES.includes(runtime as E2eGatewayRuntime)) {
    throw new Error(`Invalid gateway runtime: ${runtime}`);
  }
  return runtime as E2eGatewayRuntime;
}

export function e2eGatewayRuntimes(value: string | undefined): E2eGatewayRuntime[] {
  const requested = (value ?? "docker").split(",");
  if (
    requested.length === 0 ||
    new Set(requested).size !== requested.length ||
    requested.some((runtime) => !E2E_GATEWAY_RUNTIMES.includes(runtime as E2eGatewayRuntime))
  ) {
    throw new Error(`Invalid gateway runtimes: ${value ?? ""}`);
  }
  return requested as E2eGatewayRuntime[];
}

export function supportsE2eGatewayRuntime(
  supported: E2eGatewayRuntimeSupport,
  runtime: E2eGatewayRuntime,
): boolean {
  return supported === E2E_RUNTIME_AGNOSTIC || supported.includes(runtime);
}

export function e2eRuntimeProviders(
  supported: E2eGatewayRuntimeSupport,
  requested: readonly E2eGatewayRuntime[],
): E2eRuntimeProvider[] {
  if (supported === E2E_RUNTIME_AGNOSTIC) return ["none"];
  return requested.filter((runtime) => supported.includes(runtime));
}

export function runtimeCoverageVariant(
  variant: string,
  runtimeProvider: E2eRuntimeProvider,
): string {
  const runtimeVariant = runtimeProvider === "none" ? "runtime-agnostic" : runtimeProvider;
  return variant === "" ? runtimeVariant : `${variant}-${runtimeVariant}`;
}

export function runtimeExecutionId(
  id: string,
  variant: string,
  runtimeProvider: E2eRuntimeProvider,
): string {
  return `${id}-${runtimeCoverageVariant(variant, runtimeProvider)}`;
}
