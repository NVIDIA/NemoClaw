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
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceService,
} from "../../src/lib/onboard/runtime-provider/host-local-inference";

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
  readonly hostLocalInference?: {
    readonly services: readonly HostLocalInferenceService[];
    readonly createOperation: () => HostLocalInferenceOperation;
  };
  readonly recordEvent?: (event: string) => void;
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
  hostLocalInference,
  recordEvent = (value) => state.events.push(value),
}: InMemoryRuntimeProviderOptions): InMemoryRuntimeProviderBundle {
  const futureReason = "Unsupported by this in-memory contract fixture.";
  const event = (kind: string, sandboxName: string) => recordEvent(`${kind}:${sandboxName}`);
  const planOwnedWorkloadCleanup = (input: RuntimeProviderCleanupInput) => {
    const reference = input.sandbox.imageTag;
    const workload = input.sandbox.workload;
    if (
      workload?.kind === "legacy-dockerfile" &&
      workload.reference !== null &&
      workload.reference !== reference
    ) {
      return { action: "block" as const, reason: "authority-unproven" as const };
    }
    return input.sandbox.workload?.shared === true
      ? { action: "retain" as const, reason: "shared-image" as const }
      : reference && state.workloads.has(reference)
        ? {
            action: "remove" as const,
            engineDisplayName: "In-memory",
            reference,
          }
        : { action: "retain" as const, reason: "no-owned-image" as const };
  };
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
      hostLocalInference: hostLocalInference !== undefined,
      directLifecycle: true,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: true,
      readOnlyHostMounts: {
        supported: false,
        reason: "The in-memory runtime does not implement host-directory sharing.",
      },
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
      validateSandboxGpu: () => undefined,
      preflightLifecycle: () => null,
    },
    gateway: {
      providerId,
      supported: true,
      launcher: gatewayLauncher,
      inspectLegacyContainer: false,
      prepareHostRuntime: () => ({
        providerId,
        openShellDriver: "memory",
        bindAddress: "127.0.0.1",
        grpcHost: "127.0.0.1",
        sshGatewayHost: "127.0.0.1",
        portCheckHost: "127.0.0.1",
        socketPath: null,
        requiredServerIpSans: [],
        sandboxHostAddress: null,
        usesHostGatewayRoute: false,
        resourceOwnership: { label: "test.managed", value: providerId },
        gatewayConfig: {
          sandboxNamespace: "scoped",
          hostGatewayIp: null,
          includeSupervisorBin: true,
          processOwnership: "scoped-namespace",
        },
        network: {
          sandboxSourceCidrs: () => [],
          inspect: () => undefined,
          usesHostGatewayRoute: () => false,
          run: () => ({ status: 0 }),
          ensureProbeImageCached: () => ({ ok: true, alreadyCached: true }),
        },
      }),
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
            : receipt.kind === "native-artifact"
              ? workloadProfile.nativeArtifactSupport?.platforms.includes(receipt.platform) ===
                  true &&
                workloadProfile.nativeArtifactSupport.agents.includes(receipt.agent) &&
                workloadProfile.nativeArtifactSupport.contractVersions.includes(
                  receipt.contractVersion,
                ) &&
                workloadProfile.nativeArtifactSupport.startupProfileContractVersions.includes(
                  receipt.startupProfileContractVersion,
                )
              : receipt.platform !== undefined &&
                workloadProfile.support?.platforms.includes(receipt.platform) === true;
      },
    },
    hostLocalInference: hostLocalInference
      ? {
          providerId,
          supported: true,
          services: hostLocalInference.services,
          createOperation: hostLocalInference.createOperation,
        }
      : unsupported(providerId, futureReason),
    lifecycle: {
      providerId,
      supported: true,
      channelStopTransport: "openshell",
      privilegedSandboxControl: {
        resolveTarget: ({ sandboxName }) => ({
          providerId,
          resourceHandle: `in-memory:${sandboxName}`,
        }),
        execute: () => ({
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }),
      },
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
        "clone",
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
        return operations.detachProviders();
      },
      planOwnedWorkloadCleanup,
      removeOwnedWorkload(input: RuntimeProviderCleanupInput) {
        const plan = planOwnedWorkloadCleanup(input);
        if (plan.action !== "remove") {
          return { status: "skipped", reason: plan.reason };
        }
        state.workloads.delete(plan.reference);
        event("cleanup", input.sandboxName);
        return {
          status: "removed" as const,
          engineDisplayName: plan.engineDisplayName,
          reference: plan.reference,
        };
      },
    },
    containerEngine: {
      providerId,
      supported: true,
      identities: [
        { operation: "host-doctor", engineId: "memory", displayName: "In-memory" },
        ...(hostLocalInference
          ? [
              {
                operation: "host-local-inference" as const,
                engineId: "memory",
                displayName: "In-memory",
              },
            ]
          : []),
        { operation: "sandbox-lifecycle", engineId: "memory", displayName: "In-memory" },
        { operation: "workload-cleanup", engineId: "memory", displayName: "In-memory" },
      ],
      capture: () => ({ status: 0, stdout: "", stderr: "" }),
    },
  };
}
