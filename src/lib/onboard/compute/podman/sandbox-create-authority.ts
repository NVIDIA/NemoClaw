// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedDriverGatewayRuntimeIdentity } from "../../docker-driver-gateway-launch";
import type { OpenShellGatewayUserServiceOptions } from "../../docker-driver-gateway-service";
import { createActivePodmanWatcherController } from "./active-watcher";
import type { PodmanOpenShellWatcherController } from "./sandbox-recreate";
import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  type PodmanSocketAuthority,
} from "./socket-authority";

export interface PodmanSandboxCreateRuntimeAuthority {
  readonly cdiDevices?: readonly string[];
  readonly socketAuthority: PodmanSocketAuthority;
  readonly socketPath: string;
  readonly watcherController: PodmanOpenShellWatcherController;
}

export interface PodmanSandboxCreateRuntimeAuthorityInput {
  readonly cdiDevices?: readonly string[];
  readonly driverLabel: string;
  readonly gatewayBin: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly getRememberedGatewayPid: () => number | null;
  readonly getRuntimeDrift: (
    pid: number,
    desiredEnv: Readonly<Record<string, string>>,
    driftGatewayBin: string | null,
    trustedServicePid: number | null,
  ) => { readonly reason: string } | null;
  readonly isGatewayHealthy: () => boolean;
  readonly isPidAlive: (pid: number) => boolean;
  readonly rememberGatewayPid: (pid: number) => void;
  readonly runtimeIdentity: ManagedDriverGatewayRuntimeIdentity;
  readonly serviceOptions?: OpenShellGatewayUserServiceOptions;
  readonly socketAuthority?: PodmanSocketAuthority;
  readonly socketPath: string;
  readonly stateDir: string;
}

export interface PodmanSandboxCreateRuntimeAuthorityDependencies {
  readonly assertSocketAuthority?: typeof assertPodmanSocketAuthority;
  readonly captureSocketAuthority?: typeof capturePodmanSocketAuthority;
  readonly createWatcherController?: typeof createActivePodmanWatcherController;
}

export function createPodmanSandboxCreateRuntimeAuthority(
  input: PodmanSandboxCreateRuntimeAuthorityInput,
  dependencies: PodmanSandboxCreateRuntimeAuthorityDependencies = {},
): PodmanSandboxCreateRuntimeAuthority {
  const launch = input.runtimeIdentity.launch;
  if (!launch || launch.mode !== "host" || !input.socketPath.trim()) {
    throw new Error(
      "Podman sandbox-create authority requires the exact host launch and socket identity.",
    );
  }
  const socketAuthority =
    input.socketAuthority ??
    (dependencies.captureSocketAuthority ?? capturePodmanSocketAuthority)(input.socketPath);
  if (socketAuthority.socketPath !== input.socketPath) {
    throw new Error("Qualified Podman socket does not match sandbox-create runtime authority.");
  }
  (dependencies.assertSocketAuthority ?? assertPodmanSocketAuthority)(socketAuthority);
  return {
    cdiDevices: [...(input.cdiDevices ?? [])],
    socketAuthority,
    socketPath: input.socketPath,
    watcherController: (
      dependencies.createWatcherController ?? createActivePodmanWatcherController
    )({
      desiredEnv: input.runtimeIdentity.desiredEnv,
      driftGatewayBin: input.runtimeIdentity.driftGatewayBin,
      driverLabel: input.driverLabel,
      gatewayBin: input.gatewayBin,
      gatewayName: input.gatewayName,
      gatewayPort: input.gatewayPort,
      getRememberedGatewayPid: input.getRememberedGatewayPid,
      getRuntimeDrift: input.getRuntimeDrift,
      isGatewayHealthy: input.isGatewayHealthy,
      isPidAlive: input.isPidAlive,
      launch,
      rememberGatewayPid: input.rememberGatewayPid,
      serviceOptions: input.serviceOptions,
      stateDir: input.stateDir,
    }),
  };
}
