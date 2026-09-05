// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import type { Buffer } from "node:buffer";

type CommandResult = Pick<SpawnSyncReturns<Buffer>, "status">;
type CommandOptions = {
  ignoreError?: boolean;
  stdio?: ["ignore", "pipe", "pipe"];
  suppressOutput?: boolean;
};

export interface GatewayProcessLifecycleDeps {
  gatewayName(): string;
  runOpenshell(args: string[], options?: CommandOptions): CommandResult;
  runCaptureOpenshell(args: string[], options?: { ignoreError?: boolean }): string;
  dockerInspect(
    args: string[],
    options?: { ignoreError?: boolean; suppressOutput?: boolean },
  ): CommandResult;
  dockerStop(name: string, options?: { ignoreError?: boolean; suppressOutput?: boolean }): unknown;
  dockerRm(name: string, options?: { ignoreError?: boolean; suppressOutput?: boolean }): unknown;
  dockerRemoveVolumesByPrefix(prefix: string, options: { ignoreError: true }): unknown;
  getGatewayClusterContainerName(gatewayName: string): string;
  getDockerDriverGatewayPid(): number | null;
  isPidAlive(pid: number): boolean;
  isDockerDriverGatewayProcess(pid: number, gatewayBinary: string | null): boolean;
  resolveOpenShellGatewayBinary(): string | null;
  clearDockerDriverGatewayRuntimeFiles(): void;
  sleepSeconds(seconds: number): void;
  isDockerDriverGatewayEnabled(): boolean;
  clearRegistry(): void;
  killProcess(pid: number, signal: NodeJS.Signals): void;
  log(message: string): void;
  gatewayCliSupportsLifecycleCommands(
    capture: GatewayProcessLifecycleDeps["runCaptureOpenshell"],
  ): boolean;
  destroyGatewayWithVolumeCleanup(input: {
    clearRegistry(): void;
    dockerRemoveVolumesByPrefix: GatewayProcessLifecycleDeps["dockerRemoveVolumesByPrefix"];
    gatewayName: string;
    hasLifecycleCommands(): boolean;
    isDockerDriverGatewayEnabled(): boolean;
    removeDockerDriverGatewayRegistration(): boolean;
    runOpenshell: GatewayProcessLifecycleDeps["runOpenshell"];
    stopDockerDriverGatewayProcess(): void;
  }): boolean;
}

export function createGatewayProcessLifecycle(deps: GatewayProcessLifecycleDeps) {
  function runQuietOpenshell(args: string[]): CommandResult {
    return deps.runOpenshell(args, {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    });
  }

  function removeDockerDriverGatewayRegistration(): boolean {
    const removeResult = runQuietOpenshell(["gateway", "remove", deps.gatewayName()]);
    if (removeResult.status === 0) return true;

    // OpenShell builds before NVIDIA/OpenShell#1221 used `gateway destroy` for metadata cleanup.
    const destroyResult = runQuietOpenshell(["gateway", "destroy", "-g", deps.gatewayName()]);
    return destroyResult.status === 0;
  }

  function terminateDockerDriverGatewayProcess(pid: number): boolean {
    if (!deps.isPidAlive(pid)) return false;

    try {
      deps.killProcess(pid, "SIGTERM");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (!deps.isPidAlive(pid)) break;
        deps.sleepSeconds(1);
      }
      if (deps.isPidAlive(pid)) deps.killProcess(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }

  function stopDockerDriverGatewayProcess(): boolean {
    const pid = deps.getDockerDriverGatewayPid();
    if (pid === null || !deps.isPidAlive(pid)) {
      deps.clearDockerDriverGatewayRuntimeFiles();
      return false;
    }
    if (!deps.isDockerDriverGatewayProcess(pid, deps.resolveOpenShellGatewayBinary())) {
      deps.clearDockerDriverGatewayRuntimeFiles();
      return false;
    }

    const stopped = terminateDockerDriverGatewayProcess(pid);
    deps.clearDockerDriverGatewayRuntimeFiles();
    return stopped;
  }

  function stopLegacyGatewayClusterContainer(): boolean {
    const containerName = deps.getGatewayClusterContainerName(deps.gatewayName());
    const inspectResult = deps.dockerInspect(["--type", "container", containerName], {
      ignoreError: true,
      suppressOutput: true,
    });
    if (inspectResult.status !== 0) return false;

    deps.dockerStop(containerName, { ignoreError: true, suppressOutput: true });
    deps.dockerRm(containerName, { ignoreError: true, suppressOutput: true });

    return (
      deps.dockerInspect(["--type", "container", containerName], {
        ignoreError: true,
        suppressOutput: true,
      }).status !== 0
    );
  }

  function retireLegacyGatewayForDockerDriverUpgrade(): void {
    stopDockerDriverGatewayProcess();
    const stoppedLegacyContainer = stopLegacyGatewayClusterContainer();
    removeDockerDriverGatewayRegistration();
    if (stoppedLegacyContainer) {
      deps.log("  ✓ Legacy OpenShell gateway container stopped for Docker-driver upgrade");
    }
  }

  function destroyGateway(
    clearRegistry: () => void = deps.clearRegistry,
    isDockerDriverGatewayEnabled: () => boolean = deps.isDockerDriverGatewayEnabled,
  ): boolean {
    return deps.destroyGatewayWithVolumeCleanup({
      clearRegistry,
      dockerRemoveVolumesByPrefix: deps.dockerRemoveVolumesByPrefix,
      gatewayName: deps.gatewayName(),
      hasLifecycleCommands: () =>
        deps.gatewayCliSupportsLifecycleCommands(deps.runCaptureOpenshell),
      isDockerDriverGatewayEnabled,
      removeDockerDriverGatewayRegistration,
      runOpenshell: deps.runOpenshell,
      stopDockerDriverGatewayProcess,
    });
  }

  return {
    destroyGateway,
    removeDockerDriverGatewayRegistration,
    retireLegacyGatewayForDockerDriverUpgrade,
    runQuietOpenshell,
    stopDockerDriverGatewayProcess,
  };
}
