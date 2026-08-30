// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PodmanBoundContainerEngine, PodmanContainerEngine } from "../../adapters/podman";
import {
  RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderLifecycleInput,
  type RuntimeProviderLifecycleResult,
  type RuntimeProviderWorkloadProfile,
} from "./contract";
import type { HostLocalInferenceRouteAuthorityStore } from "./host-local-inference";
import type { PersistedEngineAuthorityStore } from "./persisted-engine-authority";
import {
  createPodmanHostLocalInferenceOperation,
  type PodmanExternalInferenceNetworkAuthority,
  type PodmanHostLocalInferenceOperationOptions,
  type PodmanInferenceFailureEvidence,
  type PodmanInferenceRedactor,
} from "./podman-host-local-inference";
import type {
  PodmanInferenceAuthorityReceipt,
  PodmanInferenceQualificationOptions,
} from "./podman-preflight";
import { startPodmanSandbox, stopPodmanSandbox } from "./podman-lifecycle";
import {
  inspectPodmanHost,
  type PodmanHostPreflightOptions,
  qualifyPodmanHost,
} from "./podman-preflight";
import { createPodmanStateMutationSurface } from "./podman-state-mutation";
import type { PodmanStateMutationSurfaceOptions } from "./podman-state-mutation";

export interface PodmanRuntimeProviderEngines {
  readonly hostDoctor: PodmanContainerEngine;
  readonly hostLocalInference?: PodmanContainerEngine;
  readonly sandboxLifecycle: PodmanContainerEngine;
  readonly stateMutation?: PodmanBoundContainerEngine;
}

export interface PodmanHostLocalInferenceOptions {
  readonly authorityStore: PersistedEngineAuthorityStore;
  readonly routeAuthorityStore: HostLocalInferenceRouteAuthorityStore;
  readonly onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void;
  readonly redactSensitive: PodmanInferenceRedactor;
  readonly externalNetwork?: PodmanExternalInferenceNetworkAuthority;
  readonly authority?: PodmanInferenceAuthorityReceipt;
  readonly authorityQualification?: PodmanInferenceQualificationOptions;
  readonly hermesPortablePublishedEngineAuthority?: PodmanHostLocalInferenceOperationOptions["hermesPortablePublishedEngineAuthority"];
}

export interface PodmanRuntimeProviderOptions {
  readonly engines: PodmanRuntimeProviderEngines;
  readonly hostLocalInference?: PodmanHostLocalInferenceOptions;
  readonly preflight?: PodmanHostPreflightOptions;
  readonly stateMutation?: Omit<PodmanStateMutationSurfaceOptions, "engine">;
}

const DORMANT_WORKLOAD_PROFILE = {
  support: null,
  hostArchitectures: [],
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: false,
} as const satisfies RuntimeProviderWorkloadProfile;

export const PODMAN_READ_ONLY_HOST_MOUNT_UNSUPPORTED_REASON =
  "Read-only host mounts are not qualified for the Podman runtime provider.";

function unsupported(providerId: string, reason: string) {
  return { providerId, supported: false as const, reason };
}

function requireEngine(
  engine: PodmanContainerEngine,
  operation: "host-doctor" | "host-local-inference" | "sandbox-lifecycle" | "state-mutation",
): void {
  if (engine.engineId !== "podman" || engine.operation !== operation) {
    throw new Error(`Podman provider requires a '${operation}' Podman engine.`);
  }
}

function preflightLifecycle(
  input: RuntimeProviderLifecycleInput,
  engine: PodmanContainerEngine,
  options: PodmanHostPreflightOptions,
): RuntimeProviderLifecycleResult | null {
  try {
    qualifyPodmanHost(engine, options);
    return null;
  } catch (error) {
    return {
      exitCode: 1,
      message: `  ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Construct an inert Podman provider candidate from explicitly scoped engine
 * dependencies. This factory is intentionally absent from the production
 * provider registry until managed startup, recovery, GPU, local inference,
 * installer, and protected E2E qualification land in later slices.
 */
export function createPodmanRuntimeProviderBundle(
  options: PodmanRuntimeProviderOptions,
): RuntimeProviderBundle {
  const providerId = "podman";
  const {
    hostDoctor,
    hostLocalInference: inferenceEngine,
    sandboxLifecycle,
    stateMutation: stateMutationEngine,
  } = options.engines;
  const inferenceOptions = options.hostLocalInference;
  const stateMutationOptions = options.stateMutation;
  requireEngine(hostDoctor, "host-doctor");
  requireEngine(sandboxLifecycle, "sandbox-lifecycle");
  const providerEndpointAuthority = hostDoctor.endpointAuthorityId;
  if (providerEndpointAuthority !== sandboxLifecycle.endpointAuthorityId) {
    throw new Error("Podman provider engines must bind the same endpoint authority.");
  }
  if ((inferenceEngine === undefined) !== (inferenceOptions === undefined)) {
    throw new Error(
      "Podman provider requires its host-local inference engine and stores together.",
    );
  }
  if (inferenceEngine !== undefined) {
    requireEngine(inferenceEngine, "host-local-inference");
    if (inferenceEngine.endpointAuthorityId !== providerEndpointAuthority) {
      throw new Error("Podman provider engines must bind the same endpoint authority.");
    }
  }
  if (stateMutationEngine !== undefined) {
    requireEngine(stateMutationEngine, "state-mutation");
    if (stateMutationEngine.endpointAuthorityId !== providerEndpointAuthority) {
      throw new Error("Podman provider engines must bind the same endpoint authority.");
    }
  }
  if (stateMutationEngine === undefined && stateMutationOptions !== undefined) {
    throw new Error("Podman provider requires its state-mutation engine with its options.");
  }
  const preflight = options.preflight ?? {};
  const deferred = "This operation is intentionally deferred to a later Podman slice.";

  return {
    identity: {
      contractVersion: RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
      id: providerId,
      displayName: "Podman",
    },
    plan: { providerId, supported: true, gatewayLauncher: "nemoclaw" },
    capabilities: {
      providerId,
      supported: true,
      hostLocalInference: inferenceEngine !== undefined,
      directLifecycle: true,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: false,
      readOnlyHostMounts: {
        supported: false,
        reason: PODMAN_READ_ONLY_HOST_MOUNT_UNSUPPORTED_REASON,
      },
    },
    preflightDoctor: {
      providerId,
      supported: true,
      inspectHost: () => inspectPodmanHost(hostDoctor, preflight),
      preflightLifecycle: (_action, input) => preflightLifecycle(input, hostDoctor, preflight),
    },
    gateway: {
      providerId,
      supported: true,
      launcher: "nemoclaw",
      inspectLegacyContainer: false,
    },
    workload: {
      providerId,
      supported: true,
      profile: DORMANT_WORKLOAD_PROFILE,
      acceptsReceipt: () => false,
    },
    hostLocalInference:
      inferenceEngine !== undefined && inferenceOptions !== undefined
        ? {
            providerId,
            supported: true,
            services: ["ollama", "nim", "vllm"],
            createOperation: ({ env, acceleration }) =>
              createPodmanHostLocalInferenceOperation({
                engine: inferenceEngine,
                env,
                acceleration,
                authorityStore: inferenceOptions.authorityStore,
                routeAuthorityStore: inferenceOptions.routeAuthorityStore,
                onFailureEvidence: inferenceOptions.onFailureEvidence,
                redactSensitive: inferenceOptions.redactSensitive,
                ...(inferenceOptions.externalNetwork
                  ? { externalNetwork: inferenceOptions.externalNetwork }
                  : {}),
                ...(inferenceOptions.authority ? { authority: inferenceOptions.authority } : {}),
                ...(inferenceOptions.authorityQualification
                  ? { authorityQualification: inferenceOptions.authorityQualification }
                  : {}),
                ...(inferenceOptions.hermesPortablePublishedEngineAuthority
                  ? {
                      hermesPortablePublishedEngineAuthority:
                        inferenceOptions.hermesPortablePublishedEngineAuthority,
                    }
                  : {}),
              }),
          }
        : unsupported(
            providerId,
            "Podman host-local inference remains disabled without injected candidate authority.",
          ),
    lifecycle: {
      providerId,
      supported: true,
      channelStopTransport: "openshell",
      start: (input) => startPodmanSandbox(input, sandboxLifecycle),
      verifyStarted: (input, verifyGateway) => verifyGateway(input.sandboxName),
      stop: (input, hooks) => stopPodmanSandbox(input, hooks, sandboxLifecycle),
    },
    mutationAuthority: {
      providerId,
      supported: true,
      operations: ["start", "stop"],
    },
    stateMutation:
      stateMutationEngine === undefined
        ? unsupported(
            providerId,
            "Podman state mutation remains disabled without injected candidate authority.",
          )
        : createPodmanStateMutationSurface({
            engine: stateMutationEngine,
            ...(stateMutationOptions ?? {}),
          }),
    bootstrap: unsupported(providerId, deferred),
    snapshot: unsupported(providerId, deferred),
    recovery: unsupported(providerId, deferred),
    cleanup: unsupported(providerId, deferred),
    containerEngine: {
      providerId,
      supported: true,
      identities: [
        {
          operation: "host-doctor",
          engineId: hostDoctor.engineId,
          displayName: hostDoctor.displayName,
        },
        ...(inferenceEngine
          ? [
              {
                operation: "host-local-inference" as const,
                engineId: inferenceEngine.engineId,
                displayName: inferenceEngine.displayName,
              },
            ]
          : []),
        {
          operation: "sandbox-lifecycle",
          engineId: sandboxLifecycle.engineId,
          displayName: sandboxLifecycle.displayName,
        },
        ...(stateMutationEngine
          ? [
              {
                operation: "state-mutation" as const,
                engineId: stateMutationEngine.engineId,
                displayName: stateMutationEngine.displayName,
              },
            ]
          : []),
      ],
    },
  };
}
