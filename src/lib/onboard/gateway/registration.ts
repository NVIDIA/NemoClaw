// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type OpenShellRuntimeSelection,
  withSelectedOpenShellCommandOptions,
} from "../../adapters/openshell/command-argv";

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
    options?: {
      env?: Record<string, string>;
      ignoreError?: boolean;
      replaceEnv?: boolean;
      stdio?: ["ignore", "pipe", "pipe"];
      suppressOutput?: boolean;
    },
  ): RunResult;
  runQuietOpenshell(args: string[]): { status: number | null };
}

export interface GatewayRegistration {
  attachGatewayMetadataIfNeeded(options?: { forceRefresh?: boolean }): boolean;
  registerDockerDriverGatewayEndpoint(runtimeSelection?: OpenShellRuntimeSelection): boolean;
}

export function createGatewayRegistration(deps: GatewayRegistrationDeps): GatewayRegistration {
  function registerDockerDriverGatewayEndpoint(
    runtimeSelection?: OpenShellRuntimeSelection,
  ): boolean {
    if (runtimeSelection && runtimeSelection.gatewayName !== deps.gatewayName()) {
      throw new Error(
        `Gateway registration target '${deps.gatewayName()}' does not match runtime selection '${runtimeSelection.gatewayName}'`,
      );
    }
    const runtimeOptions = withSelectedOpenShellCommandOptions({}, runtimeSelection);
    const runCaptureOpenshell: GatewayRegistrationDeps["runCaptureOpenshell"] = (
      args,
      options = {},
    ) =>
      deps.runCaptureOpenshell(args, { ...options, ...runtimeOptions });
    const runOpenshell: GatewayRegistrationDeps["runOpenshell"] = (args, options = {}) =>
      deps.runOpenshell(args, { ...options, ...runtimeOptions });
    const runQuietOpenshell = (args: string[]) =>
      runtimeSelection
        ? runOpenshell(args, {
            ignoreError: true,
            stdio: ["ignore", "pipe", "pipe"],
            suppressOutput: true,
          })
        : deps.runQuietOpenshell(args);
    const removeRegistration = (): boolean => {
      if (!runtimeSelection) return deps.removeDockerDriverGatewayRegistration();
      const removeResult = runQuietOpenshell(["gateway", "remove", deps.gatewayName()]);
      if (removeResult.status === 0) return true;
      return (
        runQuietOpenshell(["gateway", "destroy", "-g", deps.gatewayName()]).status === 0
      );
    };
    const selectExisting = runQuietOpenshell(["gateway", "select", deps.gatewayName()]);
    if (selectExisting.status === 0) {
      const status = runCaptureOpenshell(["status"], { ignoreError: true });
      const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName()], {
        ignoreError: true,
      });
      const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
      if (deps.isGatewayHealthy(status, namedInfo, currentInfo)) {
        process.env.OPENSHELL_GATEWAY = deps.gatewayName();
        return true;
      }
    }

    let addResult = runOpenshell(
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
      removeRegistration();
      addResult = runOpenshell(
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
    const selectResult = runOpenshell(["gateway", "select", deps.gatewayName()], {
      ignoreError: true,
      suppressOutput: true,
    });
    const ok =
      (addResult.status === 0 && selectResult.status === 0) ||
      (selectResult.status === 0 &&
        deps.isGatewayHealthy(
          runCaptureOpenshell(["status"], { ignoreError: true }),
          runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName()], {
            ignoreError: true,
          }),
          runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
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
