// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isManagedImageAgent, managedImageRuntimeIdentity } from "../managed-image/agents";
import {
  managedStartupStateRoots,
  type ManagedStartupStateRoot,
} from "../managed-startup/state-roots";
import type {
  RuntimeProviderBundle,
  RuntimeProviderBundleRegistry,
  RuntimeProviderContainerEngineOperation,
} from "../runtime-provider/contract";
import {
  removeManagedStateVolumes,
  type ManagedStateVolumeCleanupResult,
  type ManagedStateVolumeDeps,
} from "./managed-state-volumes";

export type ManagedAgentStateVolumeContext = {
  /** Registry agent; null or absent is the canonical default OpenClaw harness. */
  readonly agentName: string | null | undefined;
  readonly runtimeProviderId: string | null | undefined;
  readonly sandboxName: string;
  readonly workloadKind: string;
};

export type ManagedAgentStateVolumeCleanupResult = ManagedStateVolumeCleanupResult;

type LegacyContainerEngineRun = NonNullable<ManagedStateVolumeDeps["runContainerEngine"]>;

export type ManagedAgentStateVolumeDeps = Omit<
  ManagedStateVolumeDeps,
  "runContainerEngine" | "runtimeProvider"
> & {
  readonly runDocker?: LegacyContainerEngineRun;
  readonly runtimeProvider?: RuntimeProviderBundle;
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
};

export function selectedRuntimeProvider(
  runtimeProviderId: string | null | undefined,
  providers?: RuntimeProviderBundleRegistry,
  runtimeProvider?: RuntimeProviderBundle,
): RuntimeProviderBundle | undefined {
  if (runtimeProvider) return runtimeProvider;
  const providerId = runtimeProviderId?.trim().toLowerCase();
  return providerId && providers ? providers[providerId] : undefined;
}

export function supportsContainerEngineOperation(
  provider: RuntimeProviderBundle | undefined,
  operation: RuntimeProviderContainerEngineOperation,
): boolean {
  return (
    provider?.containerEngine.supported === true &&
    provider.containerEngine.identities.some((identity) => identity.operation === operation)
  );
}

export function managedStateVolumeDeps(
  deps: ManagedAgentStateVolumeDeps,
  runtimeProviderId: string | null | undefined,
): ManagedStateVolumeDeps {
  const runtimeProvider =
    deps.runtimeProvider ?? selectedRuntimeProvider(runtimeProviderId, deps.runtimeProviders);
  return {
    workspace: deps.workspace,
    ...(deps.runDocker && !runtimeProvider ? { runContainerEngine: deps.runDocker } : {}),
    ...(runtimeProvider ? { runtimeProvider } : {}),
    ...(deps.registerExitCleanup ? { registerExitCleanup: deps.registerExitCleanup } : {}),
  };
}

function managedAgentStateRoots(context: ManagedAgentStateVolumeContext) {
  const agentName = context.agentName ?? "openclaw";
  if (
    context.workloadKind !== "managed-image" ||
    typeof agentName !== "string" ||
    !isManagedImageAgent(agentName)
  ) {
    return [];
  }
  return managedStartupStateRoots({
    agent: agentName,
    sandboxName: context.sandboxName,
    agentIdentity: managedImageRuntimeIdentity(agentName),
  });
}

/** Remove every state root declared for a managed-image agent, gated by exact ownership labels. */
export function removeManagedAgentStateVolumes(
  context: ManagedAgentStateVolumeContext & {
    readonly retainedRoots?: readonly ManagedStartupStateRoot[];
  },
  deps: Pick<
    ManagedAgentStateVolumeDeps,
    "runDocker" | "workspace" | "runtimeProvider" | "runtimeProviders"
  > = {},
): readonly ManagedAgentStateVolumeCleanupResult[] {
  const runtimeProvider = selectedRuntimeProvider(
    context.runtimeProviderId,
    deps.runtimeProviders,
    deps.runtimeProvider,
  );
  const hasCleanupAuthority =
    !deps.runtimeProviders && !deps.runtimeProvider
      ? true
      : supportsContainerEngineOperation(runtimeProvider, "workload-cleanup");
  if (!hasCleanupAuthority) return [];
  return removeManagedStateVolumes(
    {
      roots: managedAgentStateRoots(context).filter(
        (source) =>
          !context.retainedRoots?.some(
            (target) => target.resourceIdentity === source.resourceIdentity,
          ),
      ),
    },
    managedStateVolumeDeps(deps, context.runtimeProviderId),
  );
}
