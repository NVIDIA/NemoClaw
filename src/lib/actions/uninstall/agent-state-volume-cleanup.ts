// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedAgentStateVolumeContext } from "../../onboard/managed-workload/agent-state-volumes";
import { normalizeRuntimeProviderIdentity } from "../../onboard/runtime-provider/access";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../onboard/runtime-provider/current";
import type { RuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/contract";
import { removeManagedAgentStateVolumes } from "../../onboard/sandbox-provider-cleanup";

export type { ManagedAgentStateVolumeContext };

export interface ManagedAgentStateVolumeRuntime {
  env: NodeJS.ProcessEnv;
  error(message: string): void;
  log(message: string): void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  runDocker(
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      maxBuffer?: number;
      timeout?: number;
    },
  ): { status: number | null; stderr: string; stdout: string };
  warn(message: string): void;
}

export function managedAgentStateVolumeContext(
  sandboxName: string,
  entry: Readonly<Record<string, unknown>>,
): ManagedAgentStateVolumeContext {
  const agent = entry["agent"];
  const openshellDriver = entry["openshellDriver"];
  const workload = entry["workload"];
  const workloadKind =
    workload && typeof workload === "object" && !Array.isArray(workload)
      ? (workload as Record<string, unknown>)["kind"]
      : "";
  return {
    // Null or absent is the canonical default OpenClaw harness; other non-strings stay ineligible.
    agentName:
      agent === null || agent === undefined ? null : typeof agent === "string" ? agent : "",
    runtimeProviderId:
      openshellDriver === undefined ||
      openshellDriver === null ||
      typeof openshellDriver === "string"
        ? normalizeRuntimeProviderIdentity(openshellDriver)
        : "",
    sandboxName,
    workloadKind: typeof workloadKind === "string" ? workloadKind : "",
  };
}

/** Remove every managed agent state volume of uninstalled sandboxes, as `destroy` does. */
export function removeManagedAgentStateVolumesForUninstall(
  contexts: readonly ManagedAgentStateVolumeContext[],
  runtime: ManagedAgentStateVolumeRuntime,
): boolean {
  for (const context of contexts) {
    const results = removeManagedAgentStateVolumes(context, {
      runtimeProviders: runtime.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
      runDocker: (args, options) =>
        runtime.runDocker(["volume", ...args], {
          env: runtime.env,
          maxBuffer: options?.maxBuffer,
          timeout: options?.timeout,
        }),
    });
    for (const result of results) {
      if (result.status === "failed") {
        runtime.error(`Managed agent state volume '${result.volumeName}' could not be removed.`);
        runtime.error("Preserved NemoClaw state so exact cleanup can be retried.");
        return false;
      }
      if (result.status === "not-owned") {
        runtime.warn(
          `Left managed state volume '${result.volumeName}' untouched because ${result.detail}.`,
        );
      } else if (result.status === "removed") {
        runtime.log(`Removed managed agent state volume for '${context.sandboxName}'.`);
      }
    }
  }
  return true;
}
