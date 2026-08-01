// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContainerEngine } from "../../adapters/container-engine";
import {
  RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderLifecycleInput,
  type RuntimeProviderLifecycleResult,
  type RuntimeProviderWorkloadProfile,
} from "./contract";
import type { HostLocalInferenceRuntime } from "./host-local-inference";
import { startPodmanSandbox, stopPodmanSandbox } from "./podman-lifecycle";
import {
  inspectPodmanHost,
  type PodmanHostPreflightOptions,
  qualifyPodmanHost,
} from "./podman-preflight";

export interface PodmanRuntimeProviderEngines {
  readonly hostDoctor: ContainerEngine;
  readonly hostLocalInference?: ContainerEngine;
  readonly sandboxLifecycle: ContainerEngine;
}

export interface PodmanRuntimeProviderOptions {
  readonly engines: PodmanRuntimeProviderEngines;
  readonly hostLocalInference?: HostLocalInferenceRuntime;
  readonly preflight?: PodmanHostPreflightOptions;
}

const DORMANT_WORKLOAD_PROFILE = {
  support: null,
  hostArchitectures: [],
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: false,
} as const satisfies RuntimeProviderWorkloadProfile;

function unsupported(providerId: string, reason: string) {
  return { providerId, supported: false as const, reason };
}

function requireEngine(
  engine: ContainerEngine,
  operation: "host-doctor" | "host-local-inference" | "sandbox-lifecycle",
): void {
  if (engine.engineId !== "podman" || engine.operation !== operation) {
    throw new Error(`Podman provider requires a '${operation}' Podman engine.`);
  }
}

function preflightLifecycle(
  input: RuntimeProviderLifecycleInput,
  engine: ContainerEngine,
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
    hostLocalInference: hostLocalInferenceEngine,
    sandboxLifecycle,
  } = options.engines;
  const hostLocalInference = options.hostLocalInference;
  requireEngine(hostDoctor, "host-doctor");
  requireEngine(sandboxLifecycle, "sandbox-lifecycle");
  if (hostDoctor.authorityId !== sandboxLifecycle.authorityId) {
    throw new Error("Podman provider engines must bind the same endpoint authority.");
  }
  if ((hostLocalInferenceEngine === undefined) !== (hostLocalInference === undefined)) {
    throw new Error(
      "Podman provider requires its host-local inference engine and runtime together.",
    );
  }
  if (hostLocalInferenceEngine && hostLocalInference) {
    requireEngine(hostLocalInferenceEngine, "host-local-inference");
    if (
      hostLocalInferenceEngine.authorityId !== hostDoctor.authorityId ||
      hostLocalInference.providerId !== providerId ||
      [...hostLocalInference.services].sort().join(",") !== "nim,ollama,vllm"
    ) {
      throw new Error(
        "Podman host-local inference must bind the provider endpoint and all inference services.",
      );
    }
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
      hostLocalInference: hostLocalInference !== undefined,
      directLifecycle: true,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: false,
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
    hostLocalInference: hostLocalInference
      ? { providerId, supported: true, runtime: hostLocalInference }
      : unsupported(providerId, deferred),
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
        ...(hostLocalInferenceEngine
          ? [
              {
                operation: "host-local-inference" as const,
                engineId: hostLocalInferenceEngine.engineId,
                displayName: hostLocalInferenceEngine.displayName,
              },
            ]
          : []),
        {
          operation: "sandbox-lifecycle",
          engineId: sandboxLifecycle.engineId,
          displayName: sandboxLifecycle.displayName,
        },
      ],
    },
  };
}
