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
import type {
  NativeRuntimeQualificationAuthority,
  NativeRuntimeQualificationAuthoritySource,
  NativeRuntimeQualificationProtectedJobIdentity,
} from "./native-qualification-authority";
import { createRuntimeProviderBundleRegistry } from "./registry";

export const RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION = 1 as const;
export const RUNTIME_PROVIDER_ACTIVATION_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;
export const RUNTIME_PROVIDER_ACTIVATION_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export const RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES = ["rootless"] as const;
export const RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES = ["cpu", "nvidia-gpu"] as const;
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
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SOURCE_REVISION = /^[a-f0-9]{40}$/u;
const SOURCE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const PROTECTED_REPOSITORY = "NVIDIA/NemoClaw";
const PRODUCER_WORKFLOW = ".github/workflows/e2e.yaml";

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
    readonly source: NativeRuntimeQualificationAuthoritySource;
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

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
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

function exactSequence(value: unknown, expected: readonly string[], label: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    throw new RuntimeProviderActivationError(
      `${label} must be '${expected.join(",")}' in canonical order`,
    );
  }
}

function exactSet(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value)) {
    throw new RuntimeProviderActivationError(`${label} is incomplete`);
  }
  const actual = new Set(value);
  const missing = expected.filter((entry) => !actual.has(entry));
  const unknown = value.filter((entry) => typeof entry !== "string" || !expected.includes(entry));
  if (actual.size !== value.length || missing.length > 0 || unknown.length > 0) {
    throw new RuntimeProviderActivationError(
      `${label} is incomplete (missing: ${missing.join(", ") || "none"})`,
    );
  }
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
): NativeRuntimeQualificationAuthoritySource {
  const source = record(value, label);
  exactKeys(
    source,
    [
      "candidateRepository",
      "candidateSha",
      "repository",
      "producerWorkflow",
      "pullRequestNumber",
      "baseRef",
      "baseSha",
      "workflowSha",
      "producerRunId",
      "producerRunAttempt",
      "dispatchArtifact",
      "protectedJobs",
    ],
    label,
  );
  const candidateRepository = singleLine(
    source.candidateRepository,
    `${label} candidate repository`,
  );
  if (!REPOSITORY.test(candidateRepository)) {
    throw new RuntimeProviderActivationError(`${label} candidate repository is invalid`);
  }
  if (
    source.repository !== PROTECTED_REPOSITORY ||
    source.producerWorkflow !== PRODUCER_WORKFLOW ||
    !Number.isSafeInteger(source.pullRequestNumber) ||
    Number(source.pullRequestNumber) < 1 ||
    source.baseRef !== "main"
  ) {
    throw new RuntimeProviderActivationError(
      `${label} protected repository, producer workflow, pull request, or base ref is invalid`,
    );
  }
  for (const [field, revision] of [
    ["candidate commit", source.candidateSha],
    ["target-branch base", source.baseSha],
    ["trusted workflow", source.workflowSha],
  ] as const) {
    if (typeof revision !== "string" || !SOURCE_REVISION.test(revision)) {
      throw new RuntimeProviderActivationError(`${label} ${field} SHA is invalid`);
    }
  }
  const candidateSha = source.candidateSha as string;
  const baseSha = source.baseSha as string;
  const workflowSha = source.workflowSha as string;
  if (candidateSha === baseSha || baseSha !== workflowSha) {
    throw new RuntimeProviderActivationError(
      `${label} must separate the candidate from the trusted target-branch base`,
    );
  }
  if (
    typeof source.producerRunId !== "string" ||
    !RUN_ID.test(source.producerRunId) ||
    source.producerRunAttempt !== 1
  ) {
    throw new RuntimeProviderActivationError(`${label} producer run identity is invalid`);
  }
  const dispatchArtifact = record(source.dispatchArtifact, `${label} dispatch artifact`);
  exactKeys(
    dispatchArtifact,
    ["id", "name", "digest", "sizeInBytes"],
    `${label} dispatch artifact`,
  );
  if (
    typeof dispatchArtifact.id !== "string" ||
    !RUN_ID.test(dispatchArtifact.id) ||
    dispatchArtifact.name !== `e2e-dispatch-${source.producerRunId}-${source.producerRunAttempt}` ||
    typeof dispatchArtifact.digest !== "string" ||
    !SOURCE_DIGEST.test(dispatchArtifact.digest) ||
    !Number.isSafeInteger(dispatchArtifact.sizeInBytes) ||
    Number(dispatchArtifact.sizeInBytes) < 1 ||
    Number(dispatchArtifact.sizeInBytes) > 1_048_576
  ) {
    throw new RuntimeProviderActivationError(`${label} dispatch artifact identity is invalid`);
  }
  const protectedJobs = validatedProtectedJobs(source.protectedJobs, label);
  return {
    repository: PROTECTED_REPOSITORY,
    producerWorkflow: PRODUCER_WORKFLOW,
    pullRequestNumber: Number(source.pullRequestNumber),
    candidateRepository,
    candidateSha,
    baseRef: "main",
    baseSha,
    workflowSha,
    producerRunId: source.producerRunId,
    producerRunAttempt: 1,
    dispatchArtifact: {
      id: dispatchArtifact.id,
      name: dispatchArtifact.name,
      digest: dispatchArtifact.digest,
      sizeInBytes: Number(dispatchArtifact.sizeInBytes),
    },
    protectedJobs,
  };
}

function requiredQualificationCaseIds(providerId: string): readonly string[] {
  return RUNTIME_PROVIDER_ACTIVATION_AGENTS.flatMap((agent) =>
    RUNTIME_PROVIDER_ACTIVATION_PLATFORMS.flatMap((platform) => {
      const architecture = platform.split("/")[1] as string;
      return RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES.flatMap((acceleration) => {
        const services =
          acceleration === "cpu"
            ? [RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES[0]]
            : RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES;
        const accelerationId = acceleration === "nvidia-gpu" ? "gpu" : acceleration;
        return services.map(
          (service) => `${providerId}-${agent}-linux-${architecture}-${accelerationId}-${service}`,
        );
      });
    }),
  ).sort();
}

function validatedProtectedJobs(
  value: unknown,
  label: string,
): readonly NativeRuntimeQualificationProtectedJobIdentity[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuntimeProviderActivationError(`${label} protected job identities are required`);
  }
  const jobs = value.map((entry, index) => {
    const job = record(entry, `${label} protected job ${index + 1}`);
    exactKeys(job, ["caseId", "id", "name"], `${label} protected job ${index + 1}`);
    const caseId = singleLine(job.caseId, `${label} protected job case identity`);
    const name = singleLine(job.name, `${label} protected job name`);
    if (
      typeof job.id !== "string" ||
      !RUN_ID.test(job.id) ||
      name !== `Native runtime qualification / ${caseId}`
    ) {
      throw new RuntimeProviderActivationError(`${label} protected job identity is invalid`);
    }
    return { caseId, id: job.id, name };
  });
  const caseIds = jobs.map(({ caseId }) => caseId);
  const jobIds = jobs.map(({ id }) => id);
  const names = jobs.map(({ name }) => name);
  if (
    new Set(caseIds).size !== jobs.length ||
    new Set(jobIds).size !== jobs.length ||
    new Set(names).size !== jobs.length ||
    caseIds.some((caseId, index) => index > 0 && caseIds[index - 1]! >= caseId)
  ) {
    throw new RuntimeProviderActivationError(
      `${label} protected jobs must have unique identities and canonical case order`,
    );
  }
  return jobs;
}

function sameQualificationSource(
  left: NativeRuntimeQualificationAuthoritySource,
  right: NativeRuntimeQualificationAuthoritySource,
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
  exactSequence(
    requiredSource.protectedJobs.map(({ caseId }) => caseId),
    requiredQualificationCaseIds(declaration.providerId),
    "required qualification protected jobs",
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeProviderActivationError("authenticated qualification authority is required");
  }
  const authority = record(value, "qualification authority");
  exactKeys(
    authority,
    ["schemaVersion", "kind", "qualificationId", "providerId", "source"],
    "qualification authority",
  );
  const authoritySource = validatedQualificationSource(
    authority.source,
    "qualification authority source",
  );
  if (
    authority.schemaVersion !== 1 ||
    authority.kind !== "nemoclaw-native-runtime-qualification-authority-v1" ||
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
    kind: "nemoclaw-native-runtime-qualification-authority-v1",
    qualificationId,
    providerId: declaration.providerId,
    source: authoritySource,
  };
}

function validateDeclaration(
  value: unknown,
): asserts value is RuntimeProviderActivationDeclaration {
  const declaration = record(value, "activation declaration");
  exactKeys(
    declaration,
    [
      "contractVersion",
      "providerId",
      "topology",
      "agents",
      "platforms",
      "qualificationRootModes",
      "accelerationModes",
      "hostLocalInferenceServices",
      "journeys",
      "installer",
      "qualification",
    ],
    "activation declaration",
  );
  if (
    declaration.contractVersion !== RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION ||
    typeof declaration.providerId !== "string" ||
    !PROVIDER_ID.test(declaration.providerId)
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
  const topology = record(declaration.topology, "execution topology");
  exactKeys(topology, ["hostAuthority", "transport"], "execution topology");
  if (
    !RUNTIME_PROVIDER_ACTIVATION_HOST_AUTHORITIES.includes(
      topology.hostAuthority as RuntimeProviderActivationHostAuthority,
    ) ||
    !RUNTIME_PROVIDER_ACTIVATION_TRANSPORTS.includes(
      topology.transport as RuntimeProviderActivationTransport,
    )
  ) {
    throw new RuntimeProviderActivationError("execution topology is invalid");
  }
  const installer = record(declaration.installer, "installer qualification");
  exactKeys(installer, ["releaseInstaller", "dockerUnavailable"], "installer qualification");
  if (installer.releaseInstaller !== true || installer.dockerUnavailable !== true) {
    throw new RuntimeProviderActivationError(
      "release-installer qualification with Docker unavailable is required",
    );
  }
}

function requireSupported(
  bundle: RuntimeProviderBundle,
  surfaceName: keyof RuntimeProviderBundle,
): void {
  const surface = bundle[surfaceName] as { readonly supported?: boolean };
  if (surface.supported !== true) {
    throw new RuntimeProviderActivationError(
      `provider '${bundle.identity.id}' has incomplete ${String(surfaceName)} authority`,
    );
  }
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
      `provider '${providerId}' must require digest-bound managed images`,
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

function frozenSource(
  source: NativeRuntimeQualificationAuthoritySource,
): NativeRuntimeQualificationAuthoritySource {
  return Object.freeze({
    ...source,
    dispatchArtifact: Object.freeze({ ...source.dispatchArtifact }),
    protectedJobs: Object.freeze(source.protectedJobs.map((job) => Object.freeze({ ...job }))),
  });
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
        source: frozenSource(registration.declaration.qualification.source),
      }),
    }),
    qualificationAuthority: Object.freeze({
      ...qualificationAuthority,
      source: frozenSource(qualificationAuthority.source),
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
