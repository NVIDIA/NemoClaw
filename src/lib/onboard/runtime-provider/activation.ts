// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "../managed-image/contract";
import {
  RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderBundleRegistry,
  type RuntimeProviderContainerEngineOperation,
  type RuntimeProviderMutationOperation,
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
export const RUNTIME_PROVIDER_ACTIVATION_HOST_AUTHORITIES = [
  "rootful",
  "rootless",
  "external",
] as const;
export const RUNTIME_PROVIDER_ACTIVATION_TRANSPORTS = ["operation-scoped", "socket-free"] as const;

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

export const RUNTIME_PROVIDER_ACTIVATION_ENGINE_SCOPES = [
  "host-doctor",
  "gateway-inspection",
  "host-local-inference",
  "sandbox-lifecycle",
  "state-mutation",
  "workload-cleanup",
] as const satisfies readonly RuntimeProviderContainerEngineOperation[];

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
export type RuntimeProviderActivationHostAuthority =
  (typeof RUNTIME_PROVIDER_ACTIVATION_HOST_AUTHORITIES)[number];
export type RuntimeProviderActivationTransport =
  (typeof RUNTIME_PROVIDER_ACTIVATION_TRANSPORTS)[number];

export interface RuntimeProviderActivationDeclaration {
  readonly contractVersion: typeof RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION;
  readonly providerId: string;
  readonly topology: {
    readonly hostAuthority: RuntimeProviderActivationHostAuthority;
    readonly transport: RuntimeProviderActivationTransport;
  };
  readonly agents: readonly RuntimeProviderActivationAgent[];
  readonly platforms: readonly RuntimeProviderActivationPlatform[];
  readonly qualificationRootModes: readonly RuntimeProviderActivationRootMode[];
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
    readonly authenticatedArtifact: true;
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

function exactSet(value: readonly unknown[], expected: readonly string[], label: string): void {
  const actual = new Set(value);
  const missing = expected.filter((entry) => !actual.has(entry));
  const unknown = value.filter((entry) => typeof entry !== "string" || !expected.includes(entry));
  if (
    !Array.isArray(value) ||
    actual.size !== value.length ||
    missing.length > 0 ||
    unknown.length > 0
  ) {
    throw new RuntimeProviderActivationError(
      `${label} is incomplete (missing: ${missing.join(", ") || "none"})`,
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
    !/^[a-z][a-z0-9-]{0,62}$/u.test(declaration.providerId)
  ) {
    throw new RuntimeProviderActivationError("declaration identity is malformed");
  }
  exactSequence(declaration.agents, RUNTIME_PROVIDER_ACTIVATION_AGENTS, "agents");
  exactSequence(declaration.platforms, RUNTIME_PROVIDER_ACTIVATION_PLATFORMS, "platforms");
  exactSequence(
    declaration.qualificationRootModes,
    RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES,
    "qualification root modes",
  );
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
    !RUNTIME_PROVIDER_ACTIVATION_HOST_AUTHORITIES.includes(declaration.topology?.hostAuthority) ||
    !RUNTIME_PROVIDER_ACTIVATION_TRANSPORTS.includes(declaration.topology?.transport)
  ) {
    throw new RuntimeProviderActivationError("execution topology is invalid");
  }
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
    declaration.qualification.exactHeadAndBase !== true ||
    declaration.qualification.authenticatedArtifact !== true
  ) {
    throw new RuntimeProviderActivationError(
      "authenticated protected E2E evidence bound to the exact head and base is required",
    );
  }
}

function requireSupported(
  bundle: RuntimeProviderBundle,
  surfaceName: keyof RuntimeProviderBundle,
): { readonly supported: true } {
  const surface = bundle[surfaceName] as { readonly supported?: boolean };
  if (surface.supported !== true) {
    throw new RuntimeProviderActivationError(
      `provider '${bundle.identity.id}' has incomplete ${String(surfaceName)} authority`,
    );
  }
  return surface as { readonly supported: true };
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
    "stateMutation",
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
    workload.managedImageSelectionPolicy !== "require-managed" ||
    workload.legacyDockerfileBuilds !== false
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
    bundle.hostLocalInference.services,
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
    bundle.stateMutation.supported !== true ||
    bundle.stateMutation.contractVersion !== RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION
  ) {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' has incomplete state-mutation authority`,
    );
  }
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
  exactSet(
    bundle.containerEngine.identities.map(({ operation }) => operation),
    RUNTIME_PROVIDER_ACTIVATION_ENGINE_SCOPES,
    `provider '${providerId}' engine scopes`,
  );
}

function validatedRegistration(
  registration: RuntimeProviderActivationRegistration,
): Readonly<RuntimeProviderActivationRegistration> {
  validateDeclaration(registration.declaration);
  const providerId = registration.declaration.providerId;
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
    declaration: Object.freeze({
      ...registration.declaration,
      topology: Object.freeze({ ...registration.declaration.topology }),
      agents: Object.freeze([...registration.declaration.agents]),
      platforms: Object.freeze([...registration.declaration.platforms]),
      qualificationRootModes: Object.freeze([...registration.declaration.qualificationRootModes]),
      accelerationModes: Object.freeze([...registration.declaration.accelerationModes]),
      hostLocalInferenceServices: Object.freeze([
        ...registration.declaration.hostLocalInferenceServices,
      ]),
      journeys: Object.freeze([...registration.declaration.journeys]),
      installer: Object.freeze({ ...registration.declaration.installer }),
      qualification: Object.freeze({ ...registration.declaration.qualification }),
    }),
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
