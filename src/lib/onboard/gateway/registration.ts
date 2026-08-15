// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type RunResult = ReturnType<typeof import("../../runner").run>;

export interface GatewayRegistrationDeps {
  gatewayName(): string;
  getDockerDriverGatewayEndpointArg(): string;
  getGatewayLocalEndpoint(): string;
  hasStaleGateway(gatewayInfo: string): boolean;
  isGatewayHealthy(status: string, namedInfo: string, activeInfo: string): boolean;
  isLinuxDockerDriverGatewayEnabled(): boolean;
  removeDockerDriverGatewayRegistration(): boolean;
  runCaptureOpenshell(args: string[], options?: { ignoreError?: boolean }): string;
  runOpenshell(
    args: string[],
    options?: { ignoreError?: boolean; suppressOutput?: boolean },
  ): RunResult;
  runQuietOpenshell(args: string[]): { status: number | null };
}

export interface GatewayRegistration {
  attachGatewayMetadataIfNeeded(options?: { forceRefresh?: boolean }): boolean;
  registerDockerDriverGatewayEndpoint(): boolean;
}

export function createGatewayRegistration(deps: GatewayRegistrationDeps): GatewayRegistration {
  function registerDockerDriverGatewayEndpoint(): boolean {
    const selectExisting = deps.runQuietOpenshell(["gateway", "select", deps.gatewayName()]);
    if (selectExisting.status === 0) {
      const status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
      const namedInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName()], {
        ignoreError: true,
      });
      const currentInfo = deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
      if (deps.isGatewayHealthy(status, namedInfo, currentInfo)) {
        process.env.OPENSHELL_GATEWAY = deps.gatewayName();
        return true;
      }
    }

    let addResult = deps.runOpenshell(
      [
        "gateway",
        "add",
        deps.getDockerDriverGatewayEndpointArg(),
        "--local",
        "--name",
        deps.gatewayName(),
      ],
      { ignoreError: true, suppressOutput: true },
    );
    if (addResult.status !== 0) {
      deps.removeDockerDriverGatewayRegistration();
      addResult = deps.runOpenshell(
        [
          "gateway",
          "add",
          deps.getDockerDriverGatewayEndpointArg(),
          "--local",
          "--name",
          deps.gatewayName(),
        ],
        { ignoreError: true, suppressOutput: true },
      );
    }
    const selectResult = deps.runOpenshell(["gateway", "select", deps.gatewayName()], {
      ignoreError: true,
      suppressOutput: true,
    });
    const ok =
      (addResult.status === 0 && selectResult.status === 0) ||
      (selectResult.status === 0 &&
        deps.isGatewayHealthy(
          deps.runCaptureOpenshell(["status"], { ignoreError: true }),
          deps.runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName()], {
            ignoreError: true,
          }),
          deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
        ));
    if (ok) {
      process.env.OPENSHELL_GATEWAY = deps.gatewayName();
    } else if (process.env.OPENSHELL_GATEWAY === deps.gatewayName()) {
      delete process.env.OPENSHELL_GATEWAY;
    }
    return ok;
  }

  function attachGatewayMetadataIfNeeded({
    forceRefresh = false,
  }: {
    forceRefresh?: boolean;
  } = {}): boolean {
    const gatewayInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName()], {
      ignoreError: true,
    });
    // The CLI can return stale but present metadata. Preserve the metadata unless
    // the repair flow recreates the bootstrap secrets and forces a refresh.
    if (!forceRefresh && deps.hasStaleGateway(gatewayInfo)) return true;
    if (deps.isLinuxDockerDriverGatewayEnabled()) {
      return registerDockerDriverGatewayEndpoint();
    }
    const addResult = deps.runOpenshell(
      ["gateway", "add", deps.getGatewayLocalEndpoint(), "--local", "--name", deps.gatewayName()],
      { ignoreError: true, suppressOutput: true },
    );
    if (addResult.status !== 0) return false;
    console.log("  ✓ Gateway metadata reattached");
    return true;
  }

  return { attachGatewayMetadataIfNeeded, registerDockerDriverGatewayEndpoint };
}
