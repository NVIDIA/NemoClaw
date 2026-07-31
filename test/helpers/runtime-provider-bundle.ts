// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderCleanupInput,
  type RuntimeProviderLifecycleInput,
  type RuntimeProviderLifecycleStopHooks,
  type RuntimeProviderWorkloadProfile,
} from "../../src/lib/onboard/runtime-provider/contract";

export interface InMemoryRuntimeProviderState {
  readonly events: string[];
  readonly running: Set<string>;
  readonly workloads: Set<string>;
}

export type InMemoryRuntimeProviderBundle = RuntimeProviderBundle & {
  readonly lifecycle: Extract<RuntimeProviderBundle["lifecycle"], { readonly supported: true }>;
  readonly cleanup: Extract<RuntimeProviderBundle["cleanup"], { readonly supported: true }>;
  readonly containerEngine: Extract<
    RuntimeProviderBundle["containerEngine"],
    { readonly supported: true }
  >;
};

type InMemoryRuntimeProviderOptions = {
  readonly providerId: string;
  readonly workloadProfile: RuntimeProviderWorkloadProfile;
  readonly state?: InMemoryRuntimeProviderState;
  readonly gatewayLauncher?: "nemoclaw" | "openshell";
};

function unsupported(providerId: string, reason: string) {
  return { providerId, supported: false as const, reason };
}

/**
 * Pure test fixture: no host process, socket, environment, or container
 * runtime dependency. Tests opt a provider into the complete bundle contract
 * without adding it to the production registry.
 */
export function createInMemoryRuntimeProviderBundle({
  providerId,
  workloadProfile,
  state = { events: [], running: new Set(), workloads: new Set() },
  gatewayLauncher = "nemoclaw",
}: InMemoryRuntimeProviderOptions): InMemoryRuntimeProviderBundle {
  const futureReason = "Unsupported by this in-memory contract fixture.";
  const event = (kind: string, sandboxName: string) => state.events.push(`${kind}:${sandboxName}`);
  return {
    identity: {
      contractVersion: RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
      id: providerId,
      displayName: `In-memory ${providerId}`,
    },
    plan: { providerId, supported: true, gatewayLauncher },
    capabilities: {
      providerId,
      supported: true,
      hostLocalInference: false,
      directLifecycle: true,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: true,
    },
    preflightDoctor: {
      providerId,
      supported: true,
      inspectHost: () => ({
        group: "Host",
        label: "In-memory runtime",
        status: "ok",
        detail: "ready",
      }),
      preflightLifecycle: () => null,
    },
    gateway: {
      providerId,
      supported: true,
      launcher: gatewayLauncher,
      inspectLegacyContainer: false,
    },
    workload: {
      providerId,
      supported: true,
      profile: workloadProfile,
      acceptsReceipt(receipt) {
        return receipt === undefined
          ? true
          : receipt.kind === "legacy-dockerfile"
            ? workloadProfile.legacyDockerfileBuilds
            : receipt.platform !== undefined &&
              workloadProfile.support?.platforms.includes(receipt.platform) === true;
      },
    },
    lifecycle: {
      providerId,
      supported: true,
      channelStopTransport: "openshell",
      start(input: RuntimeProviderLifecycleInput) {
        state.running.add(input.sandboxName);
        event("start", input.sandboxName);
        input.log(`  In-memory workload '${input.sandboxName}' started.`);
        return { exitCode: 0 };
      },
      async verifyStarted(input: RuntimeProviderLifecycleInput) {
        event("verify-started", input.sandboxName);
      },
      stop(input: RuntimeProviderLifecycleInput, hooks: RuntimeProviderLifecycleStopHooks) {
        const wasRunning = state.running.delete(input.sandboxName);
        const beforeStop = wasRunning ? hooks.beforeStop : () => undefined;
        const recordStop = wasRunning ? () => event("stop", input.sandboxName) : () => undefined;
        beforeStop();
        recordStop();
        return {
          exitCode: 0,
          state: wasRunning ? "stopped" : "already-stopped",
        };
      },
    },
    mutationAuthority: {
      providerId,
      supported: true,
      operations: [
        "registration",
        "start",
        "stop",
        "inference-set",
        "rebuild",
        "provider-cleanup",
        "destroy",
        "workload-cleanup",
      ],
    },
    bootstrap: unsupported(providerId, futureReason),
    snapshot: unsupported(providerId, futureReason),
    recovery: unsupported(providerId, futureReason),
    cleanup: {
      providerId,
      supported: true,
      prepareDestroy(input: RuntimeProviderCleanupInput, operations) {
        event("prepare-destroy", input.sandboxName);
        return operations.detachProviders(input.sandboxName);
      },
      removeOwnedWorkload(input: RuntimeProviderCleanupInput) {
        const reference = input.sandbox.imageTag;
        const remove = (ownedReference: string) => {
          state.workloads.delete(ownedReference);
          event("cleanup", input.sandboxName);
          return {
            status: "removed" as const,
            engineDisplayName: "In-memory",
            reference: ownedReference,
          };
        };
        return input.sandbox.workload?.shared === true
          ? { status: "skipped", reason: "shared-image" }
          : reference && state.workloads.has(reference)
            ? remove(reference)
            : { status: "skipped", reason: "no-owned-image" };
      },
    },
    containerEngine: {
      providerId,
      supported: true,
      identities: [
        { operation: "host-doctor", engineId: "memory", displayName: "In-memory" },
        { operation: "sandbox-lifecycle", engineId: "memory", displayName: "In-memory" },
        { operation: "workload-cleanup", engineId: "memory", displayName: "In-memory" },
      ],
    },
  };
}
