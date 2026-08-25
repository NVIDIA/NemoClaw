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
  requireRuntimeProviderBundle,
  runtimeProviderContainerEngineIdentity,
  runtimeProviderSupportsContainerEngineOperation,
} from "../runtime-provider/registry";
import {
  prepareManagedStateVolumes,
  removeManagedStateVolumes,
  type ManagedStateVolumeCleanupResult,
  type ManagedStateVolumeDeps,
  type ManagedStateVolumeMount,
} from "./managed-state-volumes";

export {
  managedHermesStateVolumeLabels,
  managedHermesStateVolumeName,
  MANAGED_HERMES_STATE_ROOT,
};

export type ManagedHermesStateVolumeContext = {
  readonly agentName: string | null | undefined;
  readonly runtimeProviderId: string | null | undefined;
  readonly sandboxName: string;
  readonly workloadKind: string;
};

export type ManagedHermesStateVolumeMount = ManagedStateVolumeMount & {
  readonly target: typeof MANAGED_HERMES_STATE_ROOT;
  readonly read_only: false;
};

export type ManagedHermesStateVolumeCleanupResult = ManagedStateVolumeCleanupResult;

type LegacyContainerEngineRun = NonNullable<ManagedStateVolumeDeps["runContainerEngine"]>;

export type ManagedHermesStateVolumeDeps = Omit<
  ManagedStateVolumeDeps,
  "runContainerEngine" | "runtimeProvider"
> & {
  readonly runDocker?: LegacyContainerEngineRun;
  readonly runtimeProvider?: RuntimeProviderBundle;
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
};

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
  const hasLifecycleAuthority = runtimeProvider
    ? runtimeProviderContainerEngineIdentity(runtimeProvider, "sandbox-lifecycle") !== null
    : providers
      ? runtimeProviderSupportsContainerEngineOperation(
          context.runtimeProviderId,
          providers,
          "sandbox-lifecycle",
        )
      : true;
  return (
    context.agentName === "hermes" &&
    hasLifecycleAuthority &&
    context.workloadKind === "managed-image"
  );
}

function genericDeps(
  deps: ManagedHermesStateVolumeDeps,
  runtimeProviderId: string | null | undefined,
): ManagedStateVolumeDeps {
  const runtimeProvider =
    deps.runtimeProvider ??
    (deps.runtimeProviders
      ? requireRuntimeProviderBundle(runtimeProviderId, deps.runtimeProviders)
      : undefined);
  return {
    ...(deps.runDocker && !runtimeProvider ? { runContainerEngine: deps.runDocker } : {}),
    ...(runtimeProvider ? { runtimeProvider } : {}),
    ...(deps.registerExitCleanup ? { registerExitCleanup: deps.registerExitCleanup } : {}),
  };
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
    genericDeps(deps, context.runtimeProviderId),
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
      genericDeps(deps, context.runtimeProviderId),
    )[0] ?? { status: "not-applicable" }
  );
}
