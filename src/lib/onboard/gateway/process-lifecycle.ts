// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayLifecycle } from "../../adapters/openshell/gateway-lifecycle";
import { type GatewayOwner, isExternallySupervised } from "../gateway-ownership";
import type { Buffer } from "node:buffer";
import type { SpawnSyncReturns } from "node:child_process";

import {
  resolveGatewayTeardownAuthority,
  removeGatewayRegistrationThroughAdapter,
} from "../gateway-teardown-authority";

type CommandResult = Pick<SpawnSyncReturns<Buffer>, "status"> & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};
export interface GatewayProcessLifecycleDeps {
  lifecycle: OpenShellGatewayLifecycle;
  resolveAuthority?: () => GatewayOwner;
  gatewayName(): string;
  gatewayPort?: () => number;
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
  destroyGatewayWithVolumeCleanup: typeof import("../gateway-destroy").destroyGatewayWithVolumeCleanup;
}

export function createGatewayProcessLifecycle(deps: GatewayProcessLifecycleDeps) {
  const resolveAuthority =
    deps.resolveAuthority ??
    (() => {
      const gatewayName = deps.gatewayName();
      const gatewayPort = deps.gatewayPort?.();
      if (gatewayPort === undefined)
        throw new Error("Cannot establish gateway teardown authority.");
      return resolveGatewayTeardownAuthority({ gatewayName, gatewayPort });
    });
  async function removeDockerDriverGatewayRegistration(): Promise<boolean> {
    const owner = resolveAuthority();
    return (
      await removeGatewayRegistrationThroughAdapter({
        allowLegacyDestroy: !isExternallySupervised(owner),
        gatewayName: deps.gatewayName(),
        lifecycle: deps.lifecycle,
        revalidateAuthority: resolveAuthority,
      })
    ).ok;
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

  async function retireLegacyGatewayForDockerDriverUpgrade(): Promise<void> {
    stopDockerDriverGatewayProcess();
    const stoppedLegacyContainer = stopLegacyGatewayClusterContainer();
    if (!(await removeDockerDriverGatewayRegistration()))
      throw new Error("Gateway registration cleanup failed; ownership evidence was retained.");
    if (stoppedLegacyContainer) {
      deps.log("  ✓ Legacy OpenShell gateway container stopped for Docker-driver upgrade");
    }
  }

  async function destroyGateway(
    clearRegistry: () => void = deps.clearRegistry,
    isDockerDriverGatewayEnabled: () => boolean = deps.isDockerDriverGatewayEnabled,
  ): Promise<boolean> {
    return deps.destroyGatewayWithVolumeCleanup({
      clearRegistry,
      dockerRemoveVolumesByPrefix: deps.dockerRemoveVolumesByPrefix,
      gatewayName: deps.gatewayName(),
      hasLifecycleCommands: () =>
        deps.lifecycle.supportsLegacyLifecycle({
          target: { kind: "named", gatewayName: deps.gatewayName() },
        }),
      isDockerDriverGatewayEnabled,
      removeDockerDriverGatewayRegistration,
      lifecycle: deps.lifecycle,
      resolveAuthority,
      stopDockerDriverGatewayProcess,
    });
  }

  return {
    destroyGateway,
    removeDockerDriverGatewayRegistration,
    retireLegacyGatewayForDockerDriverUpgrade,
    stopDockerDriverGatewayProcess,
  };
}
