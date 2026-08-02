// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
export type QualificationApplication = "openclaw" | "hermes" | "langchain-deepagents-code";
export type QualificationManagedImageRole = "agent" | "inference" | "probe";
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
  protectedWorkflow: string;
  provider: ExecutionProviderId;
  engineName: string;
  cases: readonly NativeRuntimeQualificationCase[];
}

export interface CompiledNativeRuntimeQualification {
  id: string;
  repository: string;
  protectedWorkflow: string;
  provider: ExecutionProviderId;
  engineName: string;
  cases: readonly Readonly<NativeRuntimeQualificationCase>[];
}

export interface QualificationArtifactReceipt {
  path: string;
  sha256: string;
}

export interface NativeRuntimeQualificationProtectedRun {
  repository: string;
  workflow: string;
  /** Exact trusted revision from which GitHub loaded the protected workflow. */
  workflowSha: string;
  runId: number;
  attempt: number;
  jobId: number;
  headSha: string;
  baseSha: string;
}

export interface NativeRuntimeQualificationEvidence {
  schemaVersion: 1;
  caseId: string;
  protectedRun: NativeRuntimeQualificationProtectedRun;
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
    application: QualificationApplication;
    inference: LocalInferenceProvider;
    architecture: ExecutionArchitecture;
    acceleration: ExecutionAcceleration;
    rootMode: "rootless";
    engineName: string;
    engineVersion: string;
    engineAuthority: {
      schemaVersion: 1;
      providerId: ExecutionProviderId;
      operation: "host-local-inference";
      engineId: string;
      authorityId: string;
      bindingSha256: string;
    };
    managedImages: readonly {
      role: QualificationManagedImageRole;
      imageRef: string;
    }[];
    route: {
      service: LocalInferenceProvider;
      endpoint: {
        host: string;
        port: number;
        networkName: string;
        gatewayProviderBaseUrl: string;
        applicationBaseUrl: "https://inference.local/v1";
      };
      authority: {
        receiptSha256: string;
        kind: "host" | "container";
        runtimeId: string | null;
        containerName: string | null;
        specSha256: string | null;
      };
    };
    modelId: string;
    inferenceResult: QualificationArtifactReceipt;
  };
  operations: readonly {
    id: QualificationObligation;
    authoritySha256: string;
    artifact: QualificationArtifactReceipt;
  }[];
  recovery: {
    status: "reconciled";
    authoritySha256: string;
    artifact: QualificationArtifactReceipt;
  };
  cleanup: {
    status: "retained-external" | "removed-owned";
    authoritySha256: string;
    providerOwnedRuntimeIds: readonly string[];
    artifact: QualificationArtifactReceipt;
  };
  nvidiaCdi?: {
    devices: readonly ["nvidia.com/gpu=all"];
    artifact: QualificationArtifactReceipt;
  };
}

export interface NativeRuntimeQualificationProtectedRunBinding {
  readonly protectedRun: NativeRuntimeQualificationProtectedRun;
  readonly artifactRoot: string;
}

export interface NativeRuntimeQualificationReporterRecord {
  readonly qualificationId: string;
  readonly caseIds: readonly string[];
}

export interface VerifiedNativeRuntimeQualificationEvidence {
  readonly qualificationId: string;
  readonly caseIds: readonly string[];
}

const compiledQualifications = new WeakSet<object>();
interface CompiledReporterState {
  readonly definition: CompiledNativeRuntimeQualification;
  readonly evidence: readonly NativeRuntimeQualificationEvidence[];
  readonly artifactRootByCaseId: ReadonlyMap<string, string>;
}
const compiledReporters = new WeakMap<object, CompiledReporterState>();
const verifiedEvidence = new WeakMap<object, CompiledReporterState>();
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IMAGE_REFERENCE_PATTERN =
  /^(?:[A-Za-z0-9._-]+(?::[0-9]+)?\/)*(?:[A-Za-z0-9._-]+)@sha256:[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/=+-]{0,511}$/u;
const MAX_QUALIFICATION_ARTIFACT_BYTES = 64 * 1024 * 1024;

const APPLICATION_BY_AGENT = {
  openclaw: "openclaw",
  hermes: "hermes",
  dcode: "langchain-deepagents-code",
} as const satisfies Readonly<Record<RuntimeAgent, QualificationApplication>>;

function assertSingleLine(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/u.test(normalized)) {
    throw new Error(`${label} must be a non-empty single-line string`);
  }
  return normalized;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} schema is unsupported`);
  }
  return record;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
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
  const acceleration = input.acceleration === "nvidia-gpu" ? "gpu" : input.acceleration;
  return [
    input.provider,
    input.agent,
    "linux",
    input.architecture,
    acceleration,
    input.inference,
  ].join("-");
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
  const protectedWorkflow = assertSingleLine(
    input.protectedWorkflow,
    "Native runtime qualification protected workflow",
  );
  const engineName = assertSingleLine(input.engineName, "Native runtime engine name");
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
    protectedWorkflow,
    provider: input.provider,
    engineName,
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

function sameArtifactMetadata(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function verifyArtifactContents(
  artifactRoot: string,
  receipt: QualificationArtifactReceipt,
  claimedPaths: Map<string, string>,
): void {
  assertArtifact(receipt, "Qualification artifact");
  const candidate = path.join(artifactRoot, ...receipt.path.split(/[\\/]/u));
  let target: string;
  try {
    target = fs.realpathSync(candidate);
  } catch {
    throw new Error(`Qualification artifact '${receipt.path}' is missing`);
  }
  const relative = path.relative(artifactRoot, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Qualification artifact '${receipt.path}' escapes its trusted root`);
  }
  const candidateMetadata = fs.lstatSync(candidate);
  if (!candidateMetadata.isFile() || candidateMetadata.isSymbolicLink()) {
    throw new Error(`Qualification artifact '${receipt.path}' must be a real regular file`);
  }
  const previousDigest = claimedPaths.get(target);
  if (previousDigest !== undefined) {
    if (previousDigest !== receipt.sha256) {
      throw new Error(
        `Qualification evidence reuses artifact '${receipt.path}' with a different digest`,
      );
    }
    return;
  }
  claimedPaths.set(target, receipt.sha256);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Qualification artifact verification requires O_NOFOLLOW");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new Error(`Qualification artifact '${receipt.path}' is not a readable regular file`);
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(MAX_QUALIFICATION_ARTIFACT_BYTES)
    ) {
      throw new Error(`Qualification artifact '${receipt.path}' failed type, link, or size checks`);
    }
    const contents = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < contents.length) {
      const count = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    const overflowCount = fs.readSync(descriptor, overflow, 0, 1, offset);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== contents.length || overflowCount !== 0 || !sameArtifactMetadata(before, after)) {
      throw new Error(`Qualification artifact '${receipt.path}' changed during verification`);
    }
    const actual = createHash("sha256").update(contents).digest("hex");
    if (actual !== receipt.sha256) {
      throw new Error(`Qualification artifact '${receipt.path}' digest does not match its receipt`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function qualificationArtifacts(
  evidence: NativeRuntimeQualificationEvidence,
): readonly QualificationArtifactReceipt[] {
  return [
    evidence.installer.invocation,
    evidence.installer.script,
    evidence.runtime.inferenceResult,
    ...evidence.operations.map((operation) => operation.artifact),
    evidence.recovery.artifact,
    evidence.cleanup.artifact,
    ...(evidence.nvidiaCdi ? [evidence.nvidiaCdi.artifact] : []),
  ];
}

function exactReporterRun(
  definition: CompiledNativeRuntimeQualification,
  input: NativeRuntimeQualificationProtectedRun,
): Readonly<NativeRuntimeQualificationProtectedRun> {
  if (
    input.repository !== definition.repository ||
    input.workflow !== definition.protectedWorkflow
  ) {
    throw new Error("Native runtime qualification reporter names the wrong protected workflow");
  }
  if (
    !SHA_PATTERN.test(input.workflowSha) ||
    !SHA_PATTERN.test(input.headSha) ||
    !SHA_PATTERN.test(input.baseSha) ||
    input.headSha === input.baseSha
  ) {
    throw new Error(
      "Native runtime qualification reporter must name exact workflow/head/base SHAs",
    );
  }
  assertPositiveInteger(input.runId, "Qualification reporter run id");
  assertPositiveInteger(input.attempt, "Qualification reporter run attempt");
  assertPositiveInteger(input.jobId, "Qualification reporter job id");
  return Object.freeze({ ...input });
}

function protectedRunKey(input: NativeRuntimeQualificationProtectedRun): string {
  return JSON.stringify([
    input.repository,
    input.workflow,
    input.workflowSha,
    input.runId,
    input.attempt,
    input.jobId,
    input.headSha,
    input.baseSha,
  ]);
}

/**
 * Bind worker-authored evidence to run/job identities and artifact roots
 * supplied independently by the trusted protected-E2E controller. The caller
 * must construct bindings from authenticated control-plane state, never from
 * candidate receipt fields.
 */
export function createNativeRuntimeQualificationReporterRecord(
  definition: CompiledNativeRuntimeQualification,
  evidence: readonly NativeRuntimeQualificationEvidence[],
  bindings: readonly NativeRuntimeQualificationProtectedRunBinding[],
): NativeRuntimeQualificationReporterRecord {
  if (!compiledQualifications.has(definition)) {
    throw new Error("Native runtime qualification reporter requires a compiled definition");
  }
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error("Native runtime qualification reporter requires trusted run bindings");
  }
  const clonedEvidence = deepFreeze(
    structuredClone(evidence) as NativeRuntimeQualificationEvidence[],
  );
  validateNativeRuntimeQualificationEvidence(definition, clonedEvidence);

  const bindingByRun = new Map<
    string,
    { readonly artifactRoot: string; readonly protectedRun: NativeRuntimeQualificationProtectedRun }
  >();
  for (const candidate of bindings) {
    const binding = exactRecord(
      candidate,
      ["artifactRoot", "protectedRun"],
      "Native runtime qualification protected-run binding",
    );
    const runRecord = exactRecord(
      binding.protectedRun,
      ["attempt", "baseSha", "headSha", "jobId", "repository", "runId", "workflow", "workflowSha"],
      "Native runtime qualification protected run",
    );
    const protectedRun = exactReporterRun(
      definition,
      runRecord as unknown as NativeRuntimeQualificationProtectedRun,
    );
    if (typeof binding.artifactRoot !== "string" || binding.artifactRoot === "") {
      throw new Error("Native runtime qualification binding artifact root is invalid");
    }
    const metadata = fs.lstatSync(binding.artifactRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Native runtime qualification artifact root must be a real directory");
    }
    const key = protectedRunKey(protectedRun);
    if (bindingByRun.has(key)) {
      throw new Error("Native runtime qualification reporter repeats a protected-run binding");
    }
    bindingByRun.set(key, {
      artifactRoot: fs.realpathSync(binding.artifactRoot),
      protectedRun,
    });
  }

  const usedBindings = new Set<string>();
  const artifactRootByCaseId = new Map<string, string>();
  for (const entry of clonedEvidence) {
    const key = protectedRunKey(entry.protectedRun);
    const binding = bindingByRun.get(key);
    if (!binding) {
      throw new Error(
        `Qualification evidence '${entry.caseId}' has no trusted protected-run binding`,
      );
    }
    usedBindings.add(key);
    artifactRootByCaseId.set(entry.caseId, binding.artifactRoot);
  }
  if (usedBindings.size !== bindingByRun.size) {
    throw new Error("Native runtime qualification reporter has an unused protected-run binding");
  }
  const reporter = Object.freeze({
    qualificationId: definition.id,
    caseIds: Object.freeze(clonedEvidence.map((entry) => entry.caseId)),
  });
  compiledReporters.set(reporter, {
    definition,
    evidence: clonedEvidence,
    artifactRootByCaseId,
  });
  return reporter;
}

/** Re-hash every worker artifact before promoting a reporter to verified evidence. */
export function verifyNativeRuntimeQualificationReporterArtifacts(
  definition: CompiledNativeRuntimeQualification,
  reporter: NativeRuntimeQualificationReporterRecord,
): VerifiedNativeRuntimeQualificationEvidence {
  const state = compiledReporters.get(reporter);
  if (state?.definition !== definition) {
    throw new Error(
      "Native runtime qualification artifacts require their canonical protected-workflow reporter",
    );
  }
  const claimedArtifactPaths = new Map<string, string>();
  for (const entry of state.evidence) {
    const artifactRoot = state.artifactRootByCaseId.get(entry.caseId);
    if (!artifactRoot) {
      throw new Error(`Qualification evidence '${entry.caseId}' lost its artifact binding`);
    }
    for (const artifact of qualificationArtifacts(entry)) {
      verifyArtifactContents(artifactRoot, artifact, claimedArtifactPaths);
    }
  }
  const verified = Object.freeze({
    qualificationId: definition.id,
    caseIds: Object.freeze(state.evidence.map((entry) => entry.caseId)),
  });
  verifiedEvidence.set(verified, state);
  return verified;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256 digest`);
  }
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact non-empty runtime identifier`);
  }
}

function requiredManagedImageRoles(
  inference: LocalInferenceProvider,
): readonly QualificationManagedImageRole[] {
  return inference === "ollama" ? ["agent", "probe"] : ["agent", "inference", "probe"];
}

function assertExactUrl(value: string, label: string): URL {
  const text = assertSingleLine(value, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} must be an exact absolute URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href !== text) {
    throw new Error(`${label} must not contain credentials, query parameters, or fragments`);
  }
  return parsed;
}

function assertEngineAuthority(
  definition: CompiledNativeRuntimeQualification,
  evidence: NativeRuntimeQualificationEvidence,
): void {
  const authority = evidence.runtime.engineAuthority;
  if (
    authority.schemaVersion !== 1 ||
    authority.providerId !== definition.provider ||
    authority.operation !== "host-local-inference"
  ) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has invalid engine authority`);
  }
  assertSafeId(authority.engineId, "Runtime engine id");
  assertSafeId(authority.authorityId, "Runtime authority id");
  assertSha256(authority.bindingSha256, "Runtime authority binding");
}

function assertInferenceRoute(
  qualificationCase: Readonly<NativeRuntimeQualificationCase>,
  evidence: NativeRuntimeQualificationEvidence,
): string {
  const route = evidence.runtime.route;
  if (route.service !== qualificationCase.inference) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has a different route service`);
  }
  const endpoint = route.endpoint;
  if (!SAFE_HOST_PATTERN.test(endpoint.host)) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has an invalid endpoint host`);
  }
  assertPositiveInteger(endpoint.port, "Inference endpoint port");
  if (endpoint.port > 65_535) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has an invalid endpoint port`);
  }
  assertSafeId(endpoint.networkName, "Inference endpoint network");
  const gateway = assertExactUrl(endpoint.gatewayProviderBaseUrl, "Gateway provider base URL");
  if (gateway.protocol !== "http:" || Number(gateway.port) !== endpoint.port) {
    throw new Error(
      `Qualification evidence '${evidence.caseId}' has a mismatched gateway endpoint`,
    );
  }
  if (endpoint.applicationBaseUrl !== "https://inference.local/v1") {
    throw new Error(
      `Qualification evidence '${evidence.caseId}' has a noncanonical application route`,
    );
  }

  const authority = route.authority;
  assertSha256(authority.receiptSha256, "Inference authority receipt");
  if (qualificationCase.inference === "ollama") {
    if (
      authority.kind !== "host" ||
      authority.runtimeId !== null ||
      authority.containerName !== null ||
      authority.specSha256 !== null
    ) {
      throw new Error(`Qualification evidence '${evidence.caseId}' must retain external Ollama`);
    }
  } else {
    if (
      authority.kind !== "container" ||
      authority.runtimeId === null ||
      authority.containerName === null ||
      authority.specSha256 === null
    ) {
      throw new Error(`Qualification evidence '${evidence.caseId}' must name managed inference`);
    }
    assertSafeId(authority.runtimeId, "Managed inference runtime id");
    assertSafeId(authority.containerName, "Managed inference container name");
    assertSha256(authority.specSha256, "Managed inference specification");
  }
  return authority.receiptSha256;
}

function assertLifecycleEvidence(
  qualificationCase: Readonly<NativeRuntimeQualificationCase>,
  evidence: NativeRuntimeQualificationEvidence,
  authoritySha256: string,
): void {
  const operationIds = evidence.operations.map((operation) => operation.id);
  assertExactSet(
    operationIds,
    qualificationCase.obligations,
    `Qualification evidence '${evidence.caseId}' operations`,
  );
  for (const operation of evidence.operations) {
    if (operation.authoritySha256 !== authoritySha256) {
      throw new Error(`Operation '${operation.id}' is bound to different runtime authority`);
    }
    assertArtifact(operation.artifact, `Operation '${operation.id}' artifact`);
  }
  if (
    evidence.recovery.status !== "reconciled" ||
    evidence.recovery.authoritySha256 !== authoritySha256
  ) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has invalid recovery evidence`);
  }
  assertArtifact(evidence.recovery.artifact, "Recovery artifact");

  const cleanupStatus =
    qualificationCase.inference === "ollama" ? "retained-external" : "removed-owned";
  if (
    evidence.cleanup.status !== cleanupStatus ||
    evidence.cleanup.authoritySha256 !== authoritySha256 ||
    evidence.cleanup.providerOwnedRuntimeIds.length !== 0
  ) {
    throw new Error(
      `Qualification evidence '${evidence.caseId}' has invalid exact cleanup evidence`,
    );
  }
  assertArtifact(evidence.cleanup.artifact, "Cleanup artifact");
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
  if (evidence.protectedRun.workflow !== definition.protectedWorkflow) {
    throw new Error(`Qualification evidence '${evidence.caseId}' belongs to the wrong workflow`);
  }
  if (!SHA_PATTERN.test(evidence.protectedRun.workflowSha)) {
    throw new Error(
      `Qualification evidence '${evidence.caseId}' must name the exact protected workflow SHA`,
    );
  }
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
    evidence.runtime.application !== APPLICATION_BY_AGENT[qualificationCase.agent] ||
    evidence.runtime.inference !== qualificationCase.inference ||
    evidence.runtime.architecture !== profile.architecture ||
    evidence.runtime.acceleration !== profile.acceleration ||
    evidence.runtime.rootMode !== "rootless"
  ) {
    throw new Error(`Qualification evidence '${evidence.caseId}' has an invalid runtime identity`);
  }
  if (evidence.runtime.engineName !== definition.engineName) {
    throw new Error(`Qualification evidence '${evidence.caseId}' names the wrong runtime engine`);
  }
  assertSingleLine(evidence.runtime.engineVersion, "Runtime engine version");
  assertEngineAuthority(definition, evidence);
  const imageRoles: QualificationManagedImageRole[] = [];
  for (const image of evidence.runtime.managedImages) {
    imageRoles.push(image.role);
    if (!IMAGE_REFERENCE_PATTERN.test(image.imageRef)) {
      throw new Error(
        `Qualification evidence '${evidence.caseId}' must use exact image references`,
      );
    }
  }
  assertExactSet(
    imageRoles,
    requiredManagedImageRoles(qualificationCase.inference),
    `Qualification evidence '${evidence.caseId}' managed image roles`,
  );
  const authoritySha256 = assertInferenceRoute(qualificationCase, evidence);
  assertSingleLine(evidence.runtime.modelId, "Inference model id");
  assertArtifact(evidence.runtime.inferenceResult, "Inference result artifact");
  assertLifecycleEvidence(qualificationCase, evidence, authoritySha256);

  if (profile.acceleration === "nvidia-gpu") {
    if (
      evidence.nvidiaCdi?.devices.length !== 1 ||
      evidence.nvidiaCdi.devices[0] !== "nvidia.com/gpu=all"
    ) {
      throw new Error(`Qualification evidence '${evidence.caseId}' must prove NVIDIA CDI access`);
    }
    assertArtifact(evidence.nvidiaCdi.artifact, "NVIDIA CDI artifact");
  } else if (evidence.nvidiaCdi !== undefined) {
    throw new Error(`CPU qualification evidence '${evidence.caseId}' must not claim NVIDIA CDI`);
  }
}

function validateNativeRuntimeQualificationEvidence(
  definition: CompiledNativeRuntimeQualification,
  evidence: readonly NativeRuntimeQualificationEvidence[],
): void {
  if (!compiledQualifications.has(definition)) {
    throw new Error("Native runtime qualification evidence requires a compiled definition");
  }
  const casesById = new Map(definition.cases.map((entry) => [entry.id, entry]));
  const evidenceById = new Map<string, NativeRuntimeQualificationEvidence>();
  const sourcePairs = new Set<string>();
  for (const entry of evidence) {
    if (evidenceById.has(entry.caseId)) {
      throw new Error(`Native runtime qualification evidence repeats case '${entry.caseId}'`);
    }
    const qualificationCase = casesById.get(entry.caseId);
    if (!qualificationCase) {
      throw new Error(`Native runtime qualification evidence names unknown case '${entry.caseId}'`);
    }
    assertCaseEvidence(definition, qualificationCase, entry);
    sourcePairs.add(
      `${entry.protectedRun.headSha}:${entry.protectedRun.baseSha}:${entry.protectedRun.workflowSha}`,
    );
    evidenceById.set(entry.caseId, entry);
  }
  const missing = definition.cases.filter((entry) => !evidenceById.has(entry.id));
  if (missing.length > 0) {
    throw new Error(
      `Native runtime qualification evidence is incomplete: ${missing.map((entry) => entry.id).join(", ")}`,
    );
  }
  if (sourcePairs.size !== 1) {
    throw new Error(
      "Native runtime qualification evidence must use one exact head/base/workflow source",
    );
  }
}

/** Accept only evidence that crossed both trusted reporter and byte-verification boundaries. */
export function assertNativeRuntimeQualificationEvidence(
  definition: CompiledNativeRuntimeQualification,
  evidence: VerifiedNativeRuntimeQualificationEvidence,
): void {
  const state = verifiedEvidence.get(evidence);
  if (state?.definition !== definition) {
    throw new Error(
      "Native runtime qualification evidence requires verified canonical reporter evidence",
    );
  }
  validateNativeRuntimeQualificationEvidence(definition, state.evidence);
}
