// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { managedImageRuntimeIdentity } from "../managed-image/agents";
import {
  managedHermesStateVolumeLabels,
  managedHermesStateVolumeName,
  managedStartupStateRoots,
  MANAGED_HERMES_STATE_ROOT,
} from "../managed-startup/state-roots";
import type {
  RuntimeProviderBundle,
  RuntimeProviderBundleRegistry,
} from "../runtime-provider/contract";
import {
  managedStateVolumeDeps,
  selectedRuntimeProvider,
  supportsContainerEngineOperation,
  type ManagedAgentStateVolumeContext,
  type ManagedAgentStateVolumeDeps,
} from "./agent-state-volumes";
import {
  prepareManagedStateVolumes,
  removeManagedStateVolumes,
  type ManagedStateVolumeCleanupResult,
  type ManagedStateVolumeMount,
} from "./managed-state-volumes";

export { managedHermesStateVolumeLabels, managedHermesStateVolumeName, MANAGED_HERMES_STATE_ROOT };

export type ManagedHermesStateVolumeContext = ManagedAgentStateVolumeContext;

export type ManagedHermesStateVolumeMount = ManagedStateVolumeMount & {
  readonly target: typeof MANAGED_HERMES_STATE_ROOT;
  readonly read_only: false;
};

export type ManagedHermesStateVolumeCleanupResult = ManagedStateVolumeCleanupResult;

export type ManagedHermesStateVolumeDeps = ManagedAgentStateVolumeDeps;

export type ManagedHermesStateVolumeScope = {
  readonly mount: ManagedHermesStateVolumeMount;
  readonly reused: boolean;
  readonly volumeName: string;
  cleanupIncompleteCreate(): ManagedHermesStateVolumeCleanupResult;
  commit(): void;
};

function hermesStateRoots(sandboxName: string) {
  return managedStartupStateRoots({
    agent: "hermes",
    sandboxName,
    agentIdentity: managedImageRuntimeIdentity("hermes"),
  });
}

export function requiresManagedHermesStateVolume(
  context: ManagedHermesStateVolumeContext,
  providers?: RuntimeProviderBundleRegistry,
  runtimeProvider?: RuntimeProviderBundle,
): boolean {
  const hasLifecycleAuthority =
    !providers && !runtimeProvider
      ? true
      : supportsContainerEngineOperation(
          selectedRuntimeProvider(context.runtimeProviderId, providers, runtimeProvider),
          "sandbox-lifecycle",
        );
  return (
    context.agentName === "hermes" &&
    hasLifecycleAuthority &&
    context.workloadKind === "managed-image"
  );
}

export function prepareManagedHermesStateVolume(
  context: ManagedHermesStateVolumeContext,
  deps: ManagedHermesStateVolumeDeps = {},
): ManagedHermesStateVolumeScope | null {
  if (!requiresManagedHermesStateVolume(context, deps.runtimeProviders, deps.runtimeProvider)) {
    return null;
  }
  const root = hermesStateRoots(context.sandboxName)[0];
  if (!root) throw new Error("Hermes managed state-root declaration is unavailable.");
  const scope = prepareManagedStateVolumes(
    { roots: [root] },
    managedStateVolumeDeps(deps, context.runtimeProviderId),
  );
  if (!scope || !scope.mounts[0]) {
    throw new Error("Hermes managed state-volume scope is unavailable.");
  }
  return {
    mount: scope.mounts[0] as ManagedHermesStateVolumeMount,
    reused: scope.reused[0] === true,
    volumeName: root.resourceIdentity,
    cleanupIncompleteCreate: () =>
      scope.cleanupIncompleteCreate()[0] ?? { status: "not-applicable" },
    commit: () => scope.commit(),
  };
}

export function removeManagedHermesStateVolume(
  context: ManagedHermesStateVolumeContext,
  deps: Pick<
    ManagedHermesStateVolumeDeps,
    "runDocker" | "runtimeProvider" | "runtimeProviders"
  > = {},
): ManagedHermesStateVolumeCleanupResult {
  if (!requiresManagedHermesStateVolume(context, deps.runtimeProviders, deps.runtimeProvider)) {
    return { status: "not-applicable" };
  }
  return (
    removeManagedStateVolumes(
      { roots: hermesStateRoots(context.sandboxName) },
      managedStateVolumeDeps(deps, context.runtimeProviderId),
    )[0] ?? { status: "not-applicable" }
  );
}
