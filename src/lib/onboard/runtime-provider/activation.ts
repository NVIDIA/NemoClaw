// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW,
  NATIVE_RUNTIME_QUALIFICATION_PROTECTED_REPOSITORY,
  type NativeRuntimeQualificationAuthority,
  type NativeRuntimeQualificationExpectedSource,
} from "./native-qualification-authority";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
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

const QUALIFICATION_ID = /^[a-z][a-z0-9-]{0,62}-protected-host-local-inference$/u;
const SOURCE_REVISION = /^[a-f0-9]{40}$/u;
const SOURCE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,128}$/u;

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
    readonly qualificationId: string;
    readonly source: NativeRuntimeQualificationExpectedSource;
  };
}

export interface RuntimeProviderActivationRegistration {
  readonly declaration: RuntimeProviderActivationDeclaration;
  readonly qualificationAuthority: NativeRuntimeQualificationAuthority;
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

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeProviderActivationError(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new RuntimeProviderActivationError(`${label} has unexpected or missing fields`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RuntimeProviderActivationError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function singleLine(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    /[\r\n]/u.test(value)
  ) {
    throw new RuntimeProviderActivationError(`${label} must be a non-empty single-line string`);
  }
  return value;
}

function validatedQualificationSource(
  value: unknown,
  label: string,
): NativeRuntimeQualificationExpectedSource {
  const source = record(value, label);
  exactKeys(
    source,
    [
      "repository",
      "workflow",
      "pullRequestNumber",
      "candidateRepository",
      "headSha",
      "baseRef",
      "baseSha",
      "runId",
      "attempt",
      "jobId",
      "artifact",
    ],
    label,
  );
  const repository = singleLine(source.repository, `${label} repository`);
  const workflow = singleLine(source.workflow, `${label} workflow`);
  const candidateRepository = singleLine(
    source.candidateRepository,
    `${label} candidate repository`,
  );
  if (
    repository !== NATIVE_RUNTIME_QUALIFICATION_PROTECTED_REPOSITORY ||
    workflow !== NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW ||
    candidateRepository !== NATIVE_RUNTIME_QUALIFICATION_PROTECTED_REPOSITORY
  ) {
    throw new RuntimeProviderActivationError(
      `${label} must bind the protected qualification repository and producer workflow`,
    );
  }
  if (
    source.baseRef !== "main" ||
    typeof source.headSha !== "string" ||
    !SOURCE_REVISION.test(source.headSha) ||
    typeof source.baseSha !== "string" ||
    !SOURCE_REVISION.test(source.baseSha) ||
    source.headSha === source.baseSha
  ) {
    throw new RuntimeProviderActivationError(
      `${label} must bind the candidate commit and target-branch base SHA`,
    );
  }
  const artifact = record(source.artifact, `${label} artifact`);
  exactKeys(artifact, ["id", "name", "digest"], `${label} artifact`);
  const artifactName = singleLine(artifact.name, `${label} artifact name`);
  if (
    !ARTIFACT_NAME.test(artifactName) ||
    typeof artifact.digest !== "string" ||
    !SOURCE_DIGEST.test(artifact.digest)
  ) {
    throw new RuntimeProviderActivationError(`${label} artifact identity is invalid`);
  }
  return {
    repository,
    workflow,
    pullRequestNumber: positiveInteger(source.pullRequestNumber, `${label} pull request number`),
    candidateRepository,
    headSha: source.headSha,
    baseRef: "main",
    baseSha: source.baseSha,
    runId: positiveInteger(source.runId, `${label} run id`),
    attempt: positiveInteger(source.attempt, `${label} run attempt`),
    jobId: positiveInteger(source.jobId, `${label} job id`),
    artifact: {
      id: positiveInteger(artifact.id, `${label} artifact id`),
      name: artifactName,
      digest: artifact.digest,
    },
  };
}

function sameQualificationSource(
  left: NativeRuntimeQualificationExpectedSource,
  right: NativeRuntimeQualificationExpectedSource,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatedQualificationAuthority(
  declaration: RuntimeProviderActivationDeclaration,
  value: unknown,
): NativeRuntimeQualificationAuthority {
  const requirement = record(declaration.qualification, "qualification requirement");
  exactKeys(requirement, ["qualificationId", "source"], "qualification requirement");
  const qualificationId = singleLine(
    requirement.qualificationId,
    "qualification requirement identity",
  );
  if (
    !QUALIFICATION_ID.test(qualificationId) ||
    qualificationId !== `${declaration.providerId}-protected-host-local-inference`
  ) {
    throw new RuntimeProviderActivationError(
      "qualification requirement does not match the provider identity",
    );
  }
  const requiredSource = validatedQualificationSource(
    requirement.source,
    "required qualification source",
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeProviderActivationError("validated qualification authority is required");
  }
  const authority = record(value, "qualification authority");
  exactKeys(
    authority,
    ["schemaVersion", "qualificationId", "providerId", "source"],
    "qualification authority",
  );
  const authoritySource = validatedQualificationSource(
    authority.source,
    "qualification authority source",
  );
  if (
    authority.schemaVersion !== 1 ||
    authority.qualificationId !== qualificationId ||
    authority.providerId !== declaration.providerId
  ) {
    throw new RuntimeProviderActivationError(
      `qualification authority does not match provider '${declaration.providerId}'`,
    );
  }
  if (!sameQualificationSource(authoritySource, requiredSource)) {
    throw new RuntimeProviderActivationError(
      "qualification authority does not match the required source identity",
    );
  }
  return {
    schemaVersion: 1,
    qualificationId,
    providerId: declaration.providerId,
    source: authoritySource,
  };
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
  if (bundle.bootstrap.supported !== true || bundle.bootstrap.bootstrapKind !== "managed-image") {
    throw new RuntimeProviderActivationError(
      `provider '${providerId}' does not provide managed-image bootstrap authority`,
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
  const qualificationAuthority = validatedQualificationAuthority(
    registration.declaration,
    registration.qualificationAuthority,
  );
  const providerId = registration.declaration.providerId;
  if (registration.bundle.identity.id !== providerId) {
    throw new RuntimeProviderActivationError(
      `declaration '${providerId}' does not match its provider bundle`,
    );
  }
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
      qualification: Object.freeze({
        qualificationId: registration.declaration.qualification.qualificationId,
        source: Object.freeze({
          ...registration.declaration.qualification.source,
          artifact: Object.freeze({
            ...registration.declaration.qualification.source.artifact,
          }),
        }),
      }),
    }),
    qualificationAuthority: Object.freeze({
      ...qualificationAuthority,
      source: Object.freeze({
        ...qualificationAuthority.source,
        artifact: Object.freeze({ ...qualificationAuthority.source.artifact }),
      }),
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
