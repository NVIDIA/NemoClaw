// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  defineExecutionProfile,
  type ExecutionAcceleration,
  type ExecutionArchitecture,
  type ExecutionCapability,
  type ExecutionProfile,
  type ExecutionProviderId,
} from "./execution-profile.ts";
import { compareCodeUnits, type RuntimeAgent } from "./scenario.ts";

export const NATIVE_RUNTIME_QUALIFICATION_AGENTS = ["openclaw", "hermes", "dcode"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES = ["amd64", "arm64"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS = ["cpu", "nvidia-gpu"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_INFERENCE = {
  cpu: ["ollama"],
  "nvidia-gpu": ["ollama", "nim", "vllm"],
} as const satisfies Readonly<Record<ExecutionAcceleration, readonly LocalInferenceProvider[]>>;

export type LocalInferenceProvider = "ollama" | "nim" | "vllm";
export type QualificationObligation =
  | "installer.install"
  | "runtime.docker-unavailable"
  | "agent.onboard"
  | "agent.turn"
  | "sandbox.stop-start"
  | "sandbox.snapshot-restore"
  | "sandbox.rebuild"
  | "runtime.restart-reconcile"
  | "cleanup.exact";
export type QualificationEvidenceKind =
  | "protected-run"
  | "source-identity"
  | "installer-result"
  | "docker-unavailable-guard"
  | "managed-images"
  | "agent-turn"
  | "local-inference"
  | "lifecycle"
  | "recovery"
  | "cleanup"
  | "nvidia-cdi";

export const NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS = [
  "installer.install",
  "runtime.docker-unavailable",
  "agent.onboard",
  "agent.turn",
  "sandbox.stop-start",
  "sandbox.snapshot-restore",
  "sandbox.rebuild",
  "runtime.restart-reconcile",
  "cleanup.exact",
] as const satisfies readonly QualificationObligation[];

const BASE_EVIDENCE_KINDS = [
  "protected-run",
  "source-identity",
  "installer-result",
  "docker-unavailable-guard",
  "managed-images",
  "agent-turn",
  "local-inference",
  "lifecycle",
  "recovery",
  "cleanup",
] as const satisfies readonly QualificationEvidenceKind[];

const REQUIRED_CAPABILITIES = [
  "agent.configure",
  "agent.turn",
  "evidence.collect",
  "sandbox.lifecycle",
  "state.observe",
  "transport.socket-free",
] as const satisfies readonly ExecutionCapability[];

export interface NativeRuntimeQualificationCase {
  id: string;
  agent: RuntimeAgent;
  profile: ExecutionProfile;
  inference: LocalInferenceProvider;
  gate: "protected-e2e";
  install: "release-installer";
  dockerAvailability: "unavailable";
  obligations: readonly QualificationObligation[];
  evidenceKinds: readonly QualificationEvidenceKind[];
}

export interface NativeRuntimeQualificationDefinition {
  id: string;
  repository: string;
  provider: ExecutionProviderId;
  cases: readonly NativeRuntimeQualificationCase[];
}

export interface CompiledNativeRuntimeQualification {
  id: string;
  repository: string;
  provider: ExecutionProviderId;
  cases: readonly Readonly<NativeRuntimeQualificationCase>[];
}

export interface QualificationArtifactReceipt {
  path: string;
  sha256: string;
}

export interface NativeRuntimeQualificationEvidence {
  schemaVersion: 1;
  caseId: string;
  protectedRun: {
    repository: string;
    workflow: string;
    runId: number;
    attempt: number;
    jobId: number;
    headSha: string;
    baseSha: string;
  };
  installer: {
    provider: ExecutionProviderId;
    architecture: ExecutionArchitecture;
    dockerAvailability: "unavailable";
    exitCode: 0;
    invocation: QualificationArtifactReceipt;
    script: QualificationArtifactReceipt;
  };
  runtime: {
    provider: ExecutionProviderId;
    profileId: string;
    agent: RuntimeAgent;
    inference: LocalInferenceProvider;
    architecture: ExecutionArchitecture;
    acceleration: ExecutionAcceleration;
    rootMode: "rootless";
    engineName: string;
    engineVersion: string;
    managedImages: readonly {
      role: string;
      digest: string;
    }[];
    result: QualificationArtifactReceipt;
  };
  operations: readonly {
    id: QualificationObligation;
    artifact: QualificationArtifactReceipt;
  }[];
  nvidiaCdi?: {
    device: "nvidia.com/gpu=all";
    artifact: QualificationArtifactReceipt;
  };
}

const compiledQualifications = new WeakSet<object>();
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function assertSingleLine(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/u.test(normalized)) {
    throw new Error(`${label} must be a non-empty single-line string`);
  }
  return normalized;
}

function assertExactSet<T extends string>(
  actual: readonly T[],
  expected: readonly T[],
  label: string,
): void {
  const actualSet = new Set(actual);
  if (actualSet.size !== actual.length) {
    throw new Error(`${label} contains duplicate values`);
  }
  const missing = expected.filter((value) => !actualSet.has(value));
  const unknown = actual.filter((value) => !expected.includes(value));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} is incomplete (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

export function requiredQualificationEvidenceKinds(
  acceleration: ExecutionAcceleration,
): readonly QualificationEvidenceKind[] {
  return acceleration === "nvidia-gpu"
    ? Object.freeze([...BASE_EVIDENCE_KINDS, "nvidia-cdi"])
    : BASE_EVIDENCE_KINDS;
}

export function qualificationCaseId(input: {
  provider: ExecutionProviderId;
  agent: RuntimeAgent;
  architecture: ExecutionArchitecture;
  acceleration: ExecutionAcceleration;
  inference: LocalInferenceProvider;
}): string {
  return [
    input.provider,
    input.agent,
    "linux",
    input.architecture,
    input.acceleration,
    input.inference,
  ]
    .join("-")
    .replace("nvidia-gpu", "gpu");
}

function coverageKey(input: {
  agent: RuntimeAgent;
  architecture: ExecutionArchitecture;
  acceleration: ExecutionAcceleration;
  inference: LocalInferenceProvider;
}): string {
  return [input.agent, input.architecture, input.acceleration, input.inference].join("|");
}

function requiredCoverageKeys(): string[] {
  return NATIVE_RUNTIME_QUALIFICATION_AGENTS.flatMap((agent) =>
    NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES.flatMap((architecture) =>
      NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS.flatMap((acceleration) =>
        NATIVE_RUNTIME_QUALIFICATION_INFERENCE[acceleration].map((inference) =>
          coverageKey({ agent, architecture, acceleration, inference }),
        ),
      ),
    ),
  ).sort(compareCodeUnits);
}

function compileCase(
  definition: NativeRuntimeQualificationDefinition,
  input: NativeRuntimeQualificationCase,
): Readonly<NativeRuntimeQualificationCase> {
  const profile = defineExecutionProfile(input.profile);
  if (profile.provider !== definition.provider) {
    throw new Error(
      `Qualification case '${input.id}' profile provider '${profile.provider}' does not match '${definition.provider}'`,
    );
  }
  if (profile.platform !== "linux" || profile.rootMode !== "rootless") {
    throw new Error(`Qualification case '${input.id}' must use a rootless Linux profile`);
  }
  const capabilities = new Set(profile.capabilities);
  const missingCapabilities = REQUIRED_CAPABILITIES.filter((value) => !capabilities.has(value));
  if (missingCapabilities.length > 0 || capabilities.has("transport.docker-socket")) {
    throw new Error(
      `Qualification case '${input.id}' must be socket-free and declares invalid capabilities (missing: ${missingCapabilities.join(", ") || "none"})`,
    );
  }
  if (input.gate !== "protected-e2e") {
    throw new Error(`Qualification case '${input.id}' must run through protected E2E`);
  }
  if (input.install !== "release-installer") {
    throw new Error(`Qualification case '${input.id}' must exercise the release installer`);
  }
  if (input.dockerAvailability !== "unavailable") {
    throw new Error(`Qualification case '${input.id}' must prove Docker is unavailable`);
  }
  const allowedInference = NATIVE_RUNTIME_QUALIFICATION_INFERENCE[profile.acceleration];
  if (!(allowedInference as readonly string[]).includes(input.inference)) {
    throw new Error(
      `Qualification case '${input.id}' cannot use ${input.inference} with ${profile.acceleration}`,
    );
  }
  assertExactSet(
    input.obligations,
    NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
    `Qualification case '${input.id}' obligations`,
  );
  assertExactSet(
    input.evidenceKinds,
    requiredQualificationEvidenceKinds(profile.acceleration),
    `Qualification case '${input.id}' evidence kinds`,
  );
  const expectedId = qualificationCaseId({
    provider: definition.provider,
    agent: input.agent,
    architecture: profile.architecture,
    acceleration: profile.acceleration,
    inference: input.inference,
  });
  if (input.id !== expectedId) {
    throw new Error(`Qualification case id '${input.id}' must be '${expectedId}'`);
  }
  return Object.freeze({
    ...input,
    profile,
    obligations: Object.freeze([...input.obligations]),
    evidenceKinds: Object.freeze([...input.evidenceKinds]),
  });
}

export function compileNativeRuntimeQualification(
  input: NativeRuntimeQualificationDefinition,
): CompiledNativeRuntimeQualification {
  const id = assertSingleLine(input.id, "Native runtime qualification id");
  const repository = assertSingleLine(input.repository, "Native runtime qualification repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`Native runtime qualification repository '${repository}' must be owner/name`);
  }
  const cases = input.cases.map((entry) => compileCase(input, entry));
  const casesByCoverage = new Map<string, Readonly<NativeRuntimeQualificationCase>>();
  for (const entry of cases) {
    const key = coverageKey({
      agent: entry.agent,
      architecture: entry.profile.architecture,
      acceleration: entry.profile.acceleration,
      inference: entry.inference,
    });
    if (casesByCoverage.has(key)) {
      throw new Error(`Native runtime qualification repeats case coverage '${key}'`);
    }
    casesByCoverage.set(key, entry);
  }
  const expectedCoverage = requiredCoverageKeys();
  const missing = expectedCoverage.filter((key) => !casesByCoverage.has(key));
  const unknown = [...casesByCoverage.keys()].filter((key) => !expectedCoverage.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Native runtime qualification coverage is incomplete (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
  const compiled = Object.freeze({
    id,
    repository,
    provider: input.provider,
    cases: Object.freeze([...cases].sort((left, right) => compareCodeUnits(left.id, right.id))),
  });
  compiledQualifications.add(compiled);
  return compiled;
}

function assertArtifact(receipt: QualificationArtifactReceipt, label: string): void {
  const artifactPath = assertSingleLine(receipt.path, `${label} path`);
  if (
    artifactPath.startsWith("/") ||
    artifactPath.startsWith("\\") ||
    artifactPath.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new Error(`${label} path must be repository-relative and traversal-free`);
  }
  if (!SHA256_PATTERN.test(receipt.sha256)) {
    throw new Error(`${label} sha256 must be an exact lowercase SHA-256 digest`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertCaseEvidence(
  definition: CompiledNativeRuntimeQualification,
  qualificationCase: Readonly<NativeRuntimeQualificationCase>,
  evidence: NativeRuntimeQualificationEvidence,
): void {
  if (evidence.schemaVersion !== 1) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has unsupported schemaVersion`);
  }
  if (evidence.protectedRun.repository !== definition.repository) {
    throw new Error(`Qualification evidence '${evidence.caseId}' belongs to the wrong repository`);
  }
  assertSingleLine(evidence.protectedRun.workflow, "Protected run workflow");
  assertPositiveInteger(evidence.protectedRun.runId, "Protected run id");
  assertPositiveInteger(evidence.protectedRun.attempt, "Protected run attempt");
  assertPositiveInteger(evidence.protectedRun.jobId, "Protected run job id");
  if (
    !SHA_PATTERN.test(evidence.protectedRun.headSha) ||
    !SHA_PATTERN.test(evidence.protectedRun.baseSha)
  ) {
    throw new Error(`Qualification evidence '${evidence.caseId}' must name exact head/base SHAs`);
  }
  if (evidence.protectedRun.headSha === evidence.protectedRun.baseSha) {
    throw new Error(`Qualification evidence '${evidence.caseId}' head/base SHAs must differ`);
  }

  const profile = qualificationCase.profile;
  if (
    evidence.installer.provider !== definition.provider ||
    evidence.installer.architecture !== profile.architecture ||
    evidence.installer.dockerAvailability !== "unavailable" ||
    evidence.installer.exitCode !== 0
  ) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has an invalid installer receipt`);
  }
  assertArtifact(evidence.installer.invocation, "Installer invocation artifact");
  assertArtifact(evidence.installer.script, "Installer script artifact");

  if (
    evidence.runtime.provider !== definition.provider ||
    evidence.runtime.profileId !== profile.id ||
    evidence.runtime.agent !== qualificationCase.agent ||
    evidence.runtime.inference !== qualificationCase.inference ||
    evidence.runtime.architecture !== profile.architecture ||
    evidence.runtime.acceleration !== profile.acceleration ||
    evidence.runtime.rootMode !== "rootless"
  ) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has an invalid runtime identity`);
  }
  assertSingleLine(evidence.runtime.engineName, "Runtime engine name");
  assertSingleLine(evidence.runtime.engineVersion, "Runtime engine version");
  if (evidence.runtime.managedImages.length === 0) {
    throw new Error(`Qualification evidence '${evidence.caseId}' must name managed images`);
  }
  const imageRoles = new Set<string>();
  for (const image of evidence.runtime.managedImages) {
    const role = assertSingleLine(image.role, "Managed image role");
    if (imageRoles.has(role)) {
      throw new Error(`Qualification evidence '${evidence.caseId}' repeats image role '${role}'`);
    }
    imageRoles.add(role);
    if (!IMAGE_DIGEST_PATTERN.test(image.digest)) {
      throw new Error(`Qualification evidence '${evidence.caseId}' must use exact image digests`);
    }
  }
  assertArtifact(evidence.runtime.result, "Runtime result artifact");

  const operationIds = evidence.operations.map((operation) => operation.id);
  assertExactSet(
    operationIds,
    qualificationCase.obligations,
    `Qualification evidence '${evidence.caseId}' operations`,
  );
  for (const operation of evidence.operations) {
    assertArtifact(operation.artifact, `Operation '${operation.id}' artifact`);
  }

  if (profile.acceleration === "nvidia-gpu") {
    if (evidence.nvidiaCdi?.device !== "nvidia.com/gpu=all") {
      throw new Error(`Qualification evidence '${evidence.caseId}' must prove NVIDIA CDI access`);
    }
    assertArtifact(evidence.nvidiaCdi.artifact, "NVIDIA CDI artifact");
  } else if (evidence.nvidiaCdi !== undefined) {
    throw new Error(`CPU qualification evidence '${evidence.caseId}' must not claim NVIDIA CDI`);
  }
}

export function assertNativeRuntimeQualificationEvidence(
  definition: CompiledNativeRuntimeQualification,
  evidence: readonly NativeRuntimeQualificationEvidence[],
): void {
  if (!compiledQualifications.has(definition)) {
    throw new Error("Native runtime qualification evidence requires a compiled definition");
  }
  const casesById = new Map(definition.cases.map((entry) => [entry.id, entry]));
  const evidenceById = new Map<string, NativeRuntimeQualificationEvidence>();
  for (const entry of evidence) {
    if (evidenceById.has(entry.caseId)) {
      throw new Error(`Native runtime qualification evidence repeats case '${entry.caseId}'`);
    }
    const qualificationCase = casesById.get(entry.caseId);
    if (!qualificationCase) {
      throw new Error(`Native runtime qualification evidence names unknown case '${entry.caseId}'`);
    }
    assertCaseEvidence(definition, qualificationCase, entry);
    evidenceById.set(entry.caseId, entry);
  }
  const missing = definition.cases.filter((entry) => !evidenceById.has(entry.id));
  if (missing.length > 0) {
    throw new Error(
      `Native runtime qualification evidence is incomplete: ${missing.map((entry) => entry.id).join(", ")}`,
    );
  }
}
