// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  composeActivatedRuntimeProviderBundles,
  RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES,
  RUNTIME_PROVIDER_ACTIVATION_AGENTS,
  RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
  RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES,
  RUNTIME_PROVIDER_ACTIVATION_JOURNEYS,
  RUNTIME_PROVIDER_ACTIVATION_PLATFORMS,
  RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES,
  type RuntimeProviderActivationRegistration,
} from "./activation";
import type { RuntimeProviderBundle, RuntimeProviderBundleRegistry } from "./contract";
import { createDockerRuntimeProviderBundle, createKubernetesRuntimeProviderBundle } from "./docker";
import { isPortableExperimentalProfile } from "../experimental/portable-profile";
import { resolveNemoClawGatewayRuntime } from "./configured-runtime";
import type { NativeRuntimeQualificationAuthority } from "./native-qualification-authority";
import { createCurrentPodmanRuntimeProviderBundle } from "./podman";
import {
  createRuntimeProviderBundleRegistry,
  requireRuntimeProviderBundle,
  resolveRuntimeProviderBundle,
} from "./registry";

/**
 * Established providers precede qualification-gated registrations so adding a
 * provider does not add another selection branch to managed orchestration.
 */
let establishedRuntimeProviderBundles: RuntimeProviderBundleRegistry | null = null;

function getEstablishedRuntimeProviderBundles(): RuntimeProviderBundleRegistry {
  establishedRuntimeProviderBundles ??= createRuntimeProviderBundleRegistry([
    ["docker", createDockerRuntimeProviderBundle()],
    ["kubernetes", createKubernetesRuntimeProviderBundle()],
  ]);
  return establishedRuntimeProviderBundles;
}

const PODMAN_QUALIFICATION_SOURCE = Object.freeze({
  repository: "NVIDIA/NemoClaw",
  workflow: ".github/workflows/e2e.yaml",
  pullRequestNumber: 9232,
  candidateRepository: "NVIDIA/NemoClaw",
  headSha: "504fcf718a8ece560c021c5ed4656851ef419e84",
  baseRef: "main" as const,
  baseSha: "146643bd71ee72cc0e1ce86ebf73a7756c0c4806",
  runId: 31984240689,
  attempt: 1,
  jobId: 95256339031,
  artifact: Object.freeze({
    id: 9273257568,
    name: "e2e-dispatch-31984240689-1",
    digest: "sha256:f75a7240e53eae1816216d0aa180dfbf0abfa6abedf9ac53791da749b07a66f8",
  }),
});

const PODMAN_QUALIFICATION_AUTHORITY: NativeRuntimeQualificationAuthority = Object.freeze({
  schemaVersion: 1,
  qualificationId: "podman-protected-host-local-inference",
  providerId: "podman",
  source: PODMAN_QUALIFICATION_SOURCE,
});

function createPodmanActivationRegistration(): RuntimeProviderActivationRegistration {
  return {
    declaration: {
      contractVersion: RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
      providerId: "podman",
      topology: {
        hostAuthority: "rootless",
        transport: "operation-scoped",
      },
      agents: RUNTIME_PROVIDER_ACTIVATION_AGENTS,
      platforms: RUNTIME_PROVIDER_ACTIVATION_PLATFORMS,
      qualificationRootModes: RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES,
      accelerationModes: RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES,
      hostLocalInferenceServices: RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES,
      journeys: RUNTIME_PROVIDER_ACTIVATION_JOURNEYS,
      installer: { releaseInstaller: true, dockerUnavailable: true },
      qualification: {
        qualificationId: PODMAN_QUALIFICATION_AUTHORITY.qualificationId,
        source: PODMAN_QUALIFICATION_SOURCE,
      },
    },
    qualificationAuthority: PODMAN_QUALIFICATION_AUTHORITY,
    bundle: createCurrentPodmanRuntimeProviderBundle(),
  };
}

let currentRuntimeProviderActivations: readonly RuntimeProviderActivationRegistration[] | null =
  null;

function getCurrentRuntimeProviderActivations(): readonly RuntimeProviderActivationRegistration[] {
  currentRuntimeProviderActivations ??= Object.freeze([createPodmanActivationRegistration()]);
  return currentRuntimeProviderActivations;
}

export function createCurrentRuntimeProviderBundles(
  activations: readonly RuntimeProviderActivationRegistration[] = getCurrentRuntimeProviderActivations(),
): RuntimeProviderBundleRegistry {
  return composeActivatedRuntimeProviderBundles(
    getEstablishedRuntimeProviderBundles(),
    activations,
  );
}

let currentRuntimeProviderBundles: RuntimeProviderBundleRegistry | null = null;

function getCurrentRuntimeProviderBundles(): RuntimeProviderBundleRegistry {
  currentRuntimeProviderBundles ??= createCurrentRuntimeProviderBundles();
  return currentRuntimeProviderBundles;
}

/**
 * Read-only lazy view of the qualification-backed current registry. Deferring
 * bundle construction until the first lookup keeps provider implementations
 * free to import provider-neutral orchestration without creating an ESM
 * initialization cycle back through this registration boundary.
 */
export const CURRENT_RUNTIME_PROVIDER_BUNDLES: RuntimeProviderBundleRegistry = new Proxy(
  Object.create(null) as RuntimeProviderBundleRegistry,
  {
    get: (_target, property) => Reflect.get(getCurrentRuntimeProviderBundles(), property),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        getCurrentRuntimeProviderBundles(),
        property,
      );
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    has: (_target, property) => Reflect.has(getCurrentRuntimeProviderBundles(), property),
    ownKeys: () => Reflect.ownKeys(getCurrentRuntimeProviderBundles()),
    defineProperty: () => false,
    deleteProperty: () => false,
    set: () => false,
  },
);

export function resolveCurrentRuntimeProviderBundle(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProviderBundle {
  const managedLocalGateway = platform === "linux" || (platform === "darwin" && arch === "arm64");
  if (!managedLocalGateway) return requireRuntimeProviderBundle("kubernetes", providers);
  if (isPortableExperimentalProfile(env)) {
    return requireRuntimeProviderBundle("docker", providers);
  }
  const configured = resolveNemoClawGatewayRuntime(env);
  if (configured === "podman" && platform !== "linux") {
    throw new Error("Native Podman runtime provider is supported only on Linux.");
  }
  return requireRuntimeProviderBundle(configured, providers);
}

export function resolveRegisteredRuntimeProviderBundle(
  providerId: string | null | undefined,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
): RuntimeProviderBundle | null {
  return resolveRuntimeProviderBundle(providerId, providers);
}
