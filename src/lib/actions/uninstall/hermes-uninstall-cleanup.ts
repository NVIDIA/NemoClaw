// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createForwardServiceController } from "../../adapters/openshell/forward-service-controller";
import { listForwardServiceReceipts } from "../../adapters/openshell/forward-service-state";
import type { ManagedHermesStateVolumeContext } from "../../onboard/managed-workload/hermes-state-volume";
import { normalizeRuntimeProviderIdentity } from "../../onboard/runtime-provider/access";
import { removeManagedHermesStateVolume } from "../../onboard/sandbox-provider-cleanup";

export { stopHermesForwardWatchers } from "./hermes-forward-watcher-cleanup";
export { requiresManagedHermesStateVolume } from "../../onboard/managed-workload/hermes-state-volume";
export type { ManagedHermesStateVolumeContext };

interface ForwardServiceUninstallRuntime {
  log(message: string): void;
  warn(message: string): void;
}

/** Retire exact receipt-owned ForwardTcp children before uninstall removes their state. */
export function stopForwardServicesForUninstall(
  registrations: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  stateDirectory: string,
  runtime: ForwardServiceUninstallRuntime,
  resolveGatewayName: (entry: Readonly<Record<string, unknown>>) => string,
): boolean {
  let receipts: ReturnType<typeof listForwardServiceReceipts>;
  try {
    receipts = listForwardServiceReceipts({ stateDirectory });
    for (const receipt of receipts) {
      const entry = registrations[receipt.sandboxName];
      if (
        !entry ||
        entry["lifecycleLiveIdentityFingerprint"] !== receipt.sandboxIdentityFingerprint ||
        resolveGatewayName(entry) !== receipt.gatewayName
      ) {
        throw new Error(
          `receipt for sandbox '${receipt.sandboxName}' has no matching selected registry authority`,
        );
      }
    }
  } catch (error) {
    runtime.warn(
      `Could not safely inspect ForwardTcp service state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  const controller = createForwardServiceController({
    // stopAll uses each receipt's admitted executable generation; it never
    // resolves or launches the current binary during teardown.
    executable: () => {
      throw new Error("ForwardTcp uninstall cleanup cannot start a process");
    },
    stateDirectory,
    // The uninstall owner holds every selected sandbox mutation lock across
    // this complete plan, including this synchronous process cleanup.
    runExclusive: (_sandboxName, operation) => operation(),
  });
  for (const [sandboxName, entry] of Object.entries(registrations)) {
    const sandboxIdentityFingerprint = entry["lifecycleLiveIdentityFingerprint"];
    if (
      typeof sandboxIdentityFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(sandboxIdentityFingerprint)
    ) {
      continue;
    }
    try {
      const stopped = controller.stopAll({
        gatewayName: resolveGatewayName(entry),
        sandboxIdentityFingerprint,
        sandboxName,
      });
      if (stopped > 0) {
        runtime.log(
          `Stopped ${String(stopped)} ForwardTcp service${stopped === 1 ? "" : "s"} for sandbox '${sandboxName}'.`,
        );
      }
    } catch (error) {
      runtime.warn(
        `Could not safely stop ForwardTcp services for sandbox '${sandboxName}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
  return true;
}

interface ManagedHermesStateVolumeRuntime {
  env: NodeJS.ProcessEnv;
  error(message: string): void;
  log(message: string): void;
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

export function managedHermesStateVolumeContext(
  sandboxName: string,
  entry: Readonly<Record<string, unknown>>,
): ManagedHermesStateVolumeContext {
  const agent = entry["agent"];
  const openshellDriver = entry["openshellDriver"];
  const workload = entry["workload"];
  const workloadKind =
    workload && typeof workload === "object" && !Array.isArray(workload)
      ? (workload as Record<string, unknown>)["kind"]
      : "";
  return {
    agentName: typeof agent === "string" ? agent : undefined,
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

export function removeManagedHermesStateVolumes(
  contexts: readonly ManagedHermesStateVolumeContext[],
  runtime: ManagedHermesStateVolumeRuntime,
): boolean {
  for (const context of contexts) {
    const result = removeManagedHermesStateVolume(context, {
      runDocker: (args, options) =>
        runtime.runDocker(["volume", ...args], {
          env: runtime.env,
          maxBuffer: options?.maxBuffer,
          timeout: options?.timeout,
        }),
    });
    if (result.status === "failed") {
      runtime.error(`Managed Hermes state volume '${result.volumeName}' could not be removed.`);
      runtime.error("Preserved NemoClaw state so exact cleanup can be retried.");
      return false;
    }
    if (result.status === "not-owned") {
      runtime.warn(`Left Docker volume '${result.volumeName}' untouched because ${result.detail}.`);
    } else if (result.status === "removed") {
      runtime.log(`Removed managed Hermes state volume for '${context.sandboxName}'.`);
    }
  }
  return true;
}
