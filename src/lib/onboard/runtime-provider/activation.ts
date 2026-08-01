// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "../managed-image/contract";
import type {
  RuntimeProviderBundle,
  RuntimeProviderBundleRegistry,
  RuntimeProviderMutationOperation,
} from "./contract";
import { createRuntimeProviderBundleRegistry } from "./registry";

export const RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION = 1 as const;

export const RUNTIME_PROVIDER_ACTIVATION_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;
export const RUNTIME_PROVIDER_ACTIVATION_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export const RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES = ["rootless"] as const;
export const RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES = ["cpu", "nvidia-cdi"] as const;
export const RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES = ["ollama", "nim", "vllm"] as const;
export const RUNTIME_PROVIDER_ACTIVATION_JOURNEYS = [
  "onboard",
  "agent-turn",
  "stop-start",
  "snapshot-restore",
  "rebuild",
  "restart-reconcile",
  "exact-cleanup",
] as const;

const REQUIRED_MUTATIONS = [
  "registration",
  "start",
  "stop",
  "inference-set",
  "rebuild",
  "clone",
  "provider-cleanup",
  "destroy",
  "workload-cleanup",
] as const satisfies readonly RuntimeProviderMutationOperation[];

const REQUIRED_CONTAINER_ENGINE_OPERATIONS = [
  "host-doctor",
  "host-local-inference",
  "sandbox-lifecycle",
  "workload-cleanup",
] as const;

export type RuntimeProviderActivationAgent = (typeof RUNTIME_PROVIDER_ACTIVATION_AGENTS)[number];
export type RuntimeProviderActivationPlatform =
  (typeof RUNTIME_PROVIDER_ACTIVATION_PLATFORMS)[number];
export type RuntimeProviderActivationRootMode =
  (typeof RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES)[number];
export type RuntimeProviderActivationAccelerationMode =
  (typeof RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES)[number];
export type RuntimeProviderActivationInferenceService =
  (typeof RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES)[number];
export type RuntimeProviderActivationJourney =
  (typeof RUNTIME_PROVIDER_ACTIVATION_JOURNEYS)[number];

/**
 * One secret-free declaration drives the final runtime, installer, docs, and
 * protected-E2E qualification boundary. It describes required evidence; its
 * presence alone is not proof that the evidence passed.
 */
export interface RuntimeProviderActivationDeclaration {
  readonly contractVersion: typeof RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION;
  readonly providerId: string;
  readonly agents: readonly RuntimeProviderActivationAgent[];
  readonly platforms: readonly RuntimeProviderActivationPlatform[];
  readonly rootModes: readonly RuntimeProviderActivationRootMode[];
  readonly accelerationModes: readonly RuntimeProviderActivationAccelerationMode[];
  readonly hostLocalInferenceServices: readonly RuntimeProviderActivationInferenceService[];
  readonly journeys: readonly RuntimeProviderActivationJourney[];
  readonly installer: {
    readonly releaseInstaller: true;
    readonly dockerUnavailable: true;
  };
  readonly qualification: {
    readonly protectedE2e: true;
    readonly exactHeadAndBase: true;
  };
}

export interface RuntimeProviderActivationRegistration {
  readonly declaration: RuntimeProviderActivationDeclaration;
  readonly bundle: RuntimeProviderBundle;
}

export type RuntimeProviderActivationCatalog = Readonly<
  Record<string, Readonly<RuntimeProviderActivationRegistration>>
>;

export class RuntimeProviderActivationError extends Error {
  constructor(message: string) {
    super(`Runtime provider activation is invalid: ${message}`);
    this.name = "RuntimeProviderActivationError";
  }
}

function exactSequence(
  value: readonly unknown[],
  expected: readonly string[],
  label: string,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    throw new RuntimeProviderActivationError(
      `${label} must be exactly '${expected.join(",")}' in canonical order`,
    );
  }
}

function validateDeclaration(declaration: RuntimeProviderActivationDeclaration): void {
  if (
    typeof declaration !== "object" ||
    declaration === null ||
    Array.isArray(declaration) ||
    declaration.contractVersion !== RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION ||
    typeof declaration.providerId !== "string" ||
    declaration.providerId.trim() !== declaration.providerId ||
    declaration.providerId === ""
  ) {
    throw new RuntimeProviderActivationError("declaration identity is malformed");
  }
  exactSequence(declaration.agents, RUNTIME_PROVIDER_ACTIVATION_AGENTS, "agents");
  exactSequence(declaration.platforms, RUNTIME_PROVIDER_ACTIVATION_PLATFORMS, "platforms");
  exactSequence(declaration.rootModes, RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES, "root modes");
  exactSequence(
    declaration.accelerationModes,
    RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES,
    "acceleration modes",
  );
  exactSequence(
    declaration.hostLocalInferenceServices,
    RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES,
    "host-local inference services",
  );
  exactSequence(declaration.journeys, RUNTIME_PROVIDER_ACTIVATION_JOURNEYS, "journeys");
  if (
    declaration.installer?.releaseInstaller !== true ||
    declaration.installer.dockerUnavailable !== true
  ) {
    throw new RuntimeProviderActivationError(
      "release-installer qualification with Docker unavailable is required",
    );
  }
  if (
    declaration.qualification?.protectedE2e !== true ||
    declaration.qualification.exactHeadAndBase !== true
  ) {
    throw new RuntimeProviderActivationError(
      "protected E2E qualification bound to the exact head and base is required",
    );
  }
}

export function normalizeRuntimeProviderActivationDeclaration(
  declaration: RuntimeProviderActivationDeclaration,
): RuntimeProviderActivationDeclaration {
  validateDeclaration(declaration);
  return Object.freeze({
    ...declaration,
    agents: Object.freeze([...declaration.agents]),
    platforms: Object.freeze([...declaration.platforms]),
    rootModes: Object.freeze([...declaration.rootModes]),
    accelerationModes: Object.freeze([...declaration.accelerationModes]),
    hostLocalInferenceServices: Object.freeze([...declaration.hostLocalInferenceServices]),
    journeys: Object.freeze([...declaration.journeys]),
    installer: Object.freeze({ ...declaration.installer }),
    qualification: Object.freeze({ ...declaration.qualification }),
  });
}

export function defineRuntimeProviderActivationDeclaration(
  providerId: string,
): RuntimeProviderActivationDeclaration {
  return normalizeRuntimeProviderActivationDeclaration({
    contractVersion: RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
    providerId,
    agents: RUNTIME_PROVIDER_ACTIVATION_AGENTS,
    platforms: RUNTIME_PROVIDER_ACTIVATION_PLATFORMS,
    rootModes: RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES,
    accelerationModes: RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES,
    hostLocalInferenceServices: RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES,
    journeys: RUNTIME_PROVIDER_ACTIVATION_JOURNEYS,
    installer: { releaseInstaller: true, dockerUnavailable: true },
    qualification: { protectedE2e: true, exactHeadAndBase: true },
  });
}

function requireSupported(bundle: RuntimeProviderBundle, surfaceName: keyof RuntimeProviderBundle) {
  const surface = bundle[surfaceName] as { readonly supported?: boolean };
  if (surface.supported !== true) {
    throw new RuntimeProviderActivationError(
      `provider '${bundle.identity.id}' has incomplete ${String(surfaceName)} authority`,
    );
  }
  return surface;
}

function validateCompleteBundle(bundle: RuntimeProviderBundle): void {
  const providerId = bundle.identity.id;
  for (const surface of [
    "plan",
    "capabilities",
    "preflightDoctor",
    "gateway",
    "workload",
    "hostLocalInference",
    "lifecycle",
    "mutationAuthority",
    "bootstrap",
    "snapshot",
    "recovery",
    "cleanup",
    "containerEngine",
  ] as const) {
    requireSupported(bundle, surface);
  }

  if (
    bundle.capabilities.hostLocalInference !== true ||
    bundle.capabilities.directLifecycle !== true ||
    bundle.capabilities.workloadImageCleanup !== true
  ) {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' does not declare the complete lifecycle capability set`,
    );
  }

  const workload = bundle.workload.profile;
  const managedImages = workload.support;
  if (
    managedImages === null ||
    managedImages.exactDigestReferences !== true ||
    workload.managedImageSelectionPolicy !== "require-managed"
  ) {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' must require exact-digest managed images`,
    );
  }
  exactSequence(
    workload.hostArchitectures,
    RUNTIME_PROVIDER_ACTIVATION_PLATFORMS.map((platform) => platform.split("/")[1] as string),
    `provider '${providerId}' host architectures`,
  );
  exactSequence(
    managedImages.platforms,
    RUNTIME_PROVIDER_ACTIVATION_PLATFORMS,
    `provider '${providerId}' managed-image platforms`,
  );
  if (
    !managedImages.startupProfileContractVersions.includes(
      MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    ) ||
    !managedImages.capabilityContractVersions.includes(MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION)
  ) {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' does not accept the current managed-image contracts`,
    );
  }

  if (bundle.hostLocalInference.supported !== true) {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' has incomplete host-local inference authority`,
    );
  }
  exactSequence(
    bundle.hostLocalInference.runtime.services,
    RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES,
    `provider '${providerId}' host-local inference services`,
  );

  if (bundle.mutationAuthority.supported !== true) {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' has incomplete mutation authority`,
    );
  }
  exactSequence(
    bundle.mutationAuthority.operations,
    REQUIRED_MUTATIONS,
    `provider '${providerId}' mutation authority`,
  );

  if (
    bundle.snapshot.supported !== true ||
    bundle.snapshot.capabilities.backup !== true ||
    bundle.snapshot.capabilities.restore !== true ||
    bundle.snapshot.capabilities.managedProfileRestore !== true
  ) {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' has incomplete snapshot and restore authority`,
    );
  }

  if (bundle.containerEngine.supported !== true) {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' has incomplete operation-scoped engine authority`,
    );
  }
  const engineOperations = bundle.containerEngine.identities.map(({ operation }) => operation);
  for (const operation of REQUIRED_CONTAINER_ENGINE_OPERATIONS) {
    if (!engineOperations.includes(operation)) {
      throw new RuntimeProviderActivationError(
        `provider '${providerId}' is missing the '${operation}' engine scope`,
      );
    }
  }
}

function validatedRegistration(
  registration: RuntimeProviderActivationRegistration,
): Readonly<RuntimeProviderActivationRegistration> {
  const declaration = normalizeRuntimeProviderActivationDeclaration(registration.declaration);
  const providerId = declaration.providerId;
  const validated = createRuntimeProviderBundleRegistry([[providerId, registration.bundle]])[
    providerId
  ];
  if (!validated || validated.identity.id !== providerId) {
    throw new RuntimeProviderActivationError(
      `declaration '${providerId}' does not match its provider bundle`,
    );
  }
  validateCompleteBundle(validated);
  return Object.freeze({
    declaration,
    bundle: validated,
  });
}

export function createRuntimeProviderActivationCatalog(
  registrations: readonly RuntimeProviderActivationRegistration[],
): RuntimeProviderActivationCatalog {
  const catalog: Record<string, Readonly<RuntimeProviderActivationRegistration>> = Object.create(
    null,
  );
  for (const registration of registrations) {
    const providerId = registration.declaration?.providerId;
    if (typeof providerId === "string" && Object.hasOwn(catalog, providerId)) {
      throw new RuntimeProviderActivationError(`duplicate provider identity '${providerId}'`);
    }
    const validated = validatedRegistration(registration);
    catalog[validated.declaration.providerId] = validated;
  }
  return Object.freeze(catalog);
}

/**
 * Compose complete, qualification-declared providers without teaching central
 * orchestration their identities. Passing no activations preserves the current
 * production-selectable registry byte-for-byte.
 */
export function composeActivatedRuntimeProviderBundles(
  base: RuntimeProviderBundleRegistry,
  activations: readonly RuntimeProviderActivationRegistration[] = [],
): RuntimeProviderBundleRegistry {
  const baseRegistry = createRuntimeProviderBundleRegistry(Object.entries(base));
  const catalog = createRuntimeProviderActivationCatalog(activations);
  for (const providerId of Object.keys(catalog)) {
    if (Object.hasOwn(baseRegistry, providerId)) {
      throw new RuntimeProviderActivationError(
        `provider identity '${providerId}' is already production-selectable`,
      );
    }
  }
  return createRuntimeProviderBundleRegistry([
    ...Object.entries(baseRegistry),
    ...Object.entries(catalog).map(
      ([providerId, registration]) => [providerId, registration.bundle] as const,
    ),
  ]);
}
