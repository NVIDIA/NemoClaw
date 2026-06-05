// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type RunOpenshell = (
  args: string[],
  opts: { ignoreError: true },
) => { status: number | null };

export type RemoveVolumesByPrefix = (
  prefix: string,
  opts: { ignoreError: true },
) => unknown;

export type DestroyGatewayDeps = {
  clearRegistry: () => void;
  dockerRemoveVolumesByPrefix: RemoveVolumesByPrefix;
  gatewayName: string;
  hasLifecycleCommands: () => boolean;
  isDockerDriverGatewayEnabled: () => boolean;
  removeDockerDriverGatewayRegistration: () => boolean;
  runOpenshell: RunOpenshell;
  stopDockerDriverGatewayProcess: () => void;
};

export function destroyGatewayWithVolumeCleanup({
  clearRegistry,
  dockerRemoveVolumesByPrefix,
  gatewayName,
  hasLifecycleCommands,
  isDockerDriverGatewayEnabled,
  removeDockerDriverGatewayRegistration,
  runOpenshell,
  stopDockerDriverGatewayProcess,
}: DestroyGatewayDeps): boolean {
  const dockerDriver = isDockerDriverGatewayEnabled();
  if (dockerDriver) {
    stopDockerDriverGatewayProcess();
  }

  const lifecycleCommands = hasLifecycleCommands();
  const gatewayRemoved = dockerDriver
    ? removeDockerDriverGatewayRegistration()
    : (() => {
        const removeResult = runOpenshell(["gateway", "remove", gatewayName], {
          ignoreError: true,
        });
        if (removeResult.status === 0) return true;
        // Pre-0.0.44 builds exposed `gateway destroy` instead of `gateway remove`.
        if (!lifecycleCommands) return false;
        return (
          runOpenshell(["gateway", "destroy", "-g", gatewayName], { ignoreError: true })
            .status === 0
        );
      })();

  if (gatewayRemoved) {
    clearRegistry();
  }

  if (gatewayRemoved && (dockerDriver || lifecycleCommands)) {
    dockerRemoveVolumesByPrefix(`openshell-cluster-${gatewayName}`, { ignoreError: true });
  }

  return gatewayRemoved;
}
