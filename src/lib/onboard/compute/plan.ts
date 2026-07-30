// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellGatewayLauncher = "nemoclaw" | "openshell";

/**
 * Keeps OpenShell driver identity separate from the component that launches
 * its gateway. A future driver does not inherit Docker lifecycle behavior
 * because NemoClaw launches its gateway.
 */
export interface OpenShellComputePlan {
  readonly driverName: string;
  readonly gatewayLauncher: OpenShellGatewayLauncher;
}

/**
 * Describes the behavior NemoClaw uses today. Driver selection will move behind
 * this seam without changing the existing Docker and Kubernetes paths first.
 */
export function resolveCurrentOpenShellComputePlan(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): OpenShellComputePlan {
  const managedDockerGateway = platform === "linux" || (platform === "darwin" && arch === "arm64");

  return {
    driverName: managedDockerGateway ? "docker" : "kubernetes",
    gatewayLauncher: managedDockerGateway ? "nemoclaw" : "openshell",
  };
}

export function usesManagedDockerGateway(
  plan: Pick<OpenShellComputePlan, "driverName" | "gatewayLauncher">,
): boolean {
  return plan.driverName === "docker" && plan.gatewayLauncher === "nemoclaw";
}
