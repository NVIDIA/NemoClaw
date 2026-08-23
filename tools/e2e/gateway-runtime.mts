// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const E2E_GATEWAY_RUNTIMES = ["docker", "podman"] as const;
export type E2eGatewayRuntime = (typeof E2E_GATEWAY_RUNTIMES)[number];

export function e2eGatewayRuntime(value: string | undefined): E2eGatewayRuntime {
  const runtime = value ?? "docker";
  if (!E2E_GATEWAY_RUNTIMES.includes(runtime as E2eGatewayRuntime)) {
    throw new Error(`Invalid gateway runtime: ${runtime}`);
  }
  return runtime as E2eGatewayRuntime;
}

export function supportsE2eGatewayRuntime(
  supported: readonly E2eGatewayRuntime[],
  runtime: E2eGatewayRuntime,
): boolean {
  return supported.includes(runtime);
}
