// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export {
  NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW,
  NATIVE_RUNTIME_QUALIFICATION_PROTECTED_REPOSITORY,
} from "../../../src/lib/onboard/runtime-provider/native-qualification-authority.ts";
import type {
  NativeRuntimeQualificationAuthority,
  NativeRuntimeQualificationExpectedSource,
  NativeRuntimeQualificationProtectedRun,
} from "../../../src/lib/onboard/runtime-provider/native-qualification-authority.ts";

export type {
  NativeRuntimeQualificationAuthority,
  NativeRuntimeQualificationExpectedSource,
  NativeRuntimeQualificationProtectedRun,
} from "../../../src/lib/onboard/runtime-provider/native-qualification-authority.ts";

export const NATIVE_RUNTIME_QUALIFICATION_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;
export const NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES = ["amd64", "arm64"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS = ["cpu", "nvidia-gpu"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_INFERENCE = {
  cpu: ["ollama"],
  "nvidia-gpu": ["ollama", "nim", "vllm"],
} as const;

export type NativeRuntimeQualificationAgent = (typeof NATIVE_RUNTIME_QUALIFICATION_AGENTS)[number];
export type NativeRuntimeQualificationArchitecture =
  (typeof NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES)[number];
export type NativeRuntimeQualificationAcceleration =
  (typeof NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS)[number];
export type NativeRuntimeQualificationInference = "ollama" | "nim" | "vllm";
export type NativeRuntimeQualificationObligation =
  | "installer.install"
  | "runtime.docker-unavailable"
  | "agent.onboard"
  | "agent.turn"
  | "sandbox.stop-start"
  | "sandbox.snapshot-restore"
  | "sandbox.rebuild"
  | "runtime.restart-reconcile"
  | "cleanup.exact";
export type NativeRuntimeQualificationEvidenceKind =
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
] as const satisfies readonly NativeRuntimeQualificationObligation[];

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
] as const satisfies readonly NativeRuntimeQualificationEvidenceKind[];
const REQUIRED_CAPABILITIES = [
  "agent.configure",
  "agent.turn",
  "evidence.collect",
  "sandbox.lifecycle",
  "state.observe",
  "transport.socket-free",
] as const;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SOURCE_REVISION = /^[a-f0-9]{40}$/u;
const SOURCE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ARTIFACT_SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,128}$/u;
const ARTIFACT_PATH = /^[A-Za-z0-9._/-]{1,256}$/u;
const compiledNativeRuntimeQualifications = new WeakSet<object>();

export interface NativeRuntimeQualificationCase {
  readonly id: string;
  readonly agent: NativeRuntimeQualificationAgent;
  readonly architecture: NativeRuntimeQualificationArchitecture;
  readonly acceleration: NativeRuntimeQualificationAcceleration;
  readonly inference: NativeRuntimeQualificationInference;
  readonly platform: "linux";
  readonly rootMode: "rootless";
  readonly capabilities: readonly string[];
  readonly gate: "protected-e2e";
  readonly install: "release-installer";
  readonly dockerAvailability: "unavailable";
  readonly obligations: readonly NativeRuntimeQualificationObligation[];
  readonly evidenceKinds: readonly NativeRuntimeQualificationEvidenceKind[];
}

export interface NativeRuntimeQualificationDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly repository: "NVIDIA/NemoClaw";
  readonly providerId: string;
  readonly executionPath: "runtime-provider-bundle";
  readonly cases: readonly NativeRuntimeQualificationCase[];
}

export interface NativeRuntimeCandidateEvidence {
  readonly schemaVersion: 1;
  readonly claim: "candidate-execution-prerequisites";
  readonly candidateId: "podman-cpu-lifecycle";
  readonly providerId: string;
  readonly sourceRevision: string;
  readonly executionPath: "runtime-provider-bundle";
  readonly architecture: "amd64";
  readonly acceleration: "cpu";
  readonly agents: readonly NativeRuntimeQualificationAgent[];
  readonly socketFree: true;
  readonly dockerUnavailable: {
    readonly service: true;
    readonly socket: true;
    readonly daemon: true;
    readonly invocationGuard: true;
  };
}

export interface NativeRuntimeCandidateAuthority {
  readonly schemaVersion: 1;
  readonly candidateId: "podman-cpu-lifecycle";
  readonly providerId: string;
  readonly sourceRevision: string;
  readonly executionPath: "runtime-provider-bundle";
}

export interface NativeRuntimeQualificationArtifactReceipt {
  readonly path: string;
  readonly sha256: string;
}

export interface NativeRuntimeQualificationCaseEvidence {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly protectedRun: NativeRuntimeQualificationProtectedRun;
  readonly installer: {
    readonly providerId: string;
    readonly architecture: NativeRuntimeQualificationArchitecture;
    readonly dockerAvailability: "unavailable";
    readonly exitCode: 0;
    readonly invocation: NativeRuntimeQualificationArtifactReceipt;
    readonly script: NativeRuntimeQualificationArtifactReceipt;
  };
  readonly runtime: {
    readonly providerId: string;
    readonly agent: NativeRuntimeQualificationAgent;
    readonly inference: NativeRuntimeQualificationInference;
    readonly architecture: NativeRuntimeQualificationArchitecture;
    readonly acceleration: NativeRuntimeQualificationAcceleration;
    readonly rootMode: "rootless";
    readonly engineName: string;
    readonly engineVersion: string;
    readonly managedImages: readonly {
      readonly role: string;
      readonly digest: string;
    }[];
    readonly result: NativeRuntimeQualificationArtifactReceipt;
  };
  readonly operations: readonly {
    readonly id: NativeRuntimeQualificationObligation;
    readonly artifact: NativeRuntimeQualificationArtifactReceipt;
  }[];
  readonly nvidiaCdi?: {
    readonly device: "nvidia.com/gpu=all";
    readonly artifact: NativeRuntimeQualificationArtifactReceipt;
  };
}

export interface NativeRuntimeQualificationEvidenceEnvelope {
  readonly schemaVersion: 1;
  readonly qualificationId: string;
  readonly providerId: string;
  readonly cases: readonly NativeRuntimeQualificationCaseEvidence[];
}

export type NativeRuntimeQualificationReceiptReader = (path: string) => Buffer | null;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const canonical = [...expected].sort(compareCodeUnits);
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
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
    throw new Error(`${label} must be a non-empty single-line string`);
  }
  return value;
}

function exactSet<T extends string>(actual: readonly T[], expected: readonly T[], label: string) {
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unknown = actual.filter((value) => !expected.includes(value));
  if (actualSet.size !== actual.length || missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} is incomplete (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

export function requiredNativeRuntimeQualificationEvidenceKinds(
  acceleration: NativeRuntimeQualificationAcceleration,
): readonly NativeRuntimeQualificationEvidenceKind[] {
  return acceleration === "nvidia-gpu"
    ? Object.freeze([...BASE_EVIDENCE_KINDS, "nvidia-cdi"])
    : BASE_EVIDENCE_KINDS;
}

export function nativeRuntimeQualificationCaseId(input: {
  readonly providerId: string;
  readonly agent: NativeRuntimeQualificationAgent;
  readonly architecture: NativeRuntimeQualificationArchitecture;
  readonly acceleration: NativeRuntimeQualificationAcceleration;
  readonly inference: NativeRuntimeQualificationInference;
}): string {
  const acceleration = input.acceleration === "nvidia-gpu" ? "gpu" : input.acceleration;
  return [
    input.providerId,
    input.agent,
    "linux",
    input.architecture,
    acceleration,
    input.inference,
  ].join("-");
}

function coverageKey(
  value: Pick<
    NativeRuntimeQualificationCase,
    "agent" | "architecture" | "acceleration" | "inference"
  >,
): string {
  return [value.agent, value.architecture, value.acceleration, value.inference].join("|");
}

function requiredCoverageKeys(): readonly string[] {
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

export function compileNativeRuntimeQualification(
  definition: NativeRuntimeQualificationDefinition,
): NativeRuntimeQualificationDefinition {
  if (
    definition.schemaVersion !== 1 ||
    !PROVIDER_ID.test(definition.providerId) ||
    definition.id !== `${definition.providerId}-protected-host-local-inference` ||
    definition.repository !== "NVIDIA/NemoClaw" ||
    definition.executionPath !== "runtime-provider-bundle"
  ) {
    throw new Error("Native runtime qualification identity is invalid");
  }
  const cases = definition.cases.map((entry) => {
    const expectedId = nativeRuntimeQualificationCaseId({
      providerId: definition.providerId,
      agent: entry.agent,
      architecture: entry.architecture,
      acceleration: entry.acceleration,
      inference: entry.inference,
    });
    const inference = NATIVE_RUNTIME_QUALIFICATION_INFERENCE[entry.acceleration];
    const capabilities = new Set(entry.capabilities);
    if (
      entry.id !== expectedId ||
      entry.platform !== "linux" ||
      entry.rootMode !== "rootless" ||
      entry.gate !== "protected-e2e" ||
      entry.install !== "release-installer" ||
      entry.dockerAvailability !== "unavailable" ||
      !(inference as readonly string[]).includes(entry.inference) ||
      REQUIRED_CAPABILITIES.some((value) => !capabilities.has(value)) ||
      capabilities.has("transport.docker-socket")
    ) {
      throw new Error(`Native runtime qualification case '${entry.id}' is invalid`);
    }
    exactSet(
      entry.obligations,
      NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
      `Native runtime qualification case '${entry.id}' obligations`,
    );
    exactSet(
      entry.evidenceKinds,
      requiredNativeRuntimeQualificationEvidenceKinds(entry.acceleration),
      `Native runtime qualification case '${entry.id}' evidence kinds`,
    );
    return Object.freeze({
      ...entry,
      capabilities: Object.freeze([...entry.capabilities]),
      obligations: Object.freeze([...entry.obligations]),
      evidenceKinds: Object.freeze([...entry.evidenceKinds]),
    });
  });
  const coverage = new Map(cases.map((entry) => [coverageKey(entry), entry]));
  const required = requiredCoverageKeys();
  const missing = required.filter((key) => !coverage.has(key));
  if (coverage.size !== cases.length || coverage.size !== required.length || missing.length > 0) {
    throw new Error(
      `Native runtime qualification coverage is incomplete (missing: ${missing.join(", ") || "none"})`,
    );
  }
  const compiled = Object.freeze({
    ...definition,
    cases: Object.freeze([...cases].sort((left, right) => compareCodeUnits(left.id, right.id))),
  });
  compiledNativeRuntimeQualifications.add(compiled);
  return compiled;
}

export function nativeRuntimeQualificationDefinition(
  providerId: string,
): NativeRuntimeQualificationDefinition {
  const capabilities = [...REQUIRED_CAPABILITIES];
  return {
    schemaVersion: 1,
    id: `${providerId}-protected-host-local-inference`,
    repository: "NVIDIA/NemoClaw",
    providerId,
    executionPath: "runtime-provider-bundle",
    cases: NATIVE_RUNTIME_QUALIFICATION_AGENTS.flatMap((agent) =>
      NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES.flatMap((architecture) =>
        NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS.flatMap((acceleration) =>
          NATIVE_RUNTIME_QUALIFICATION_INFERENCE[acceleration].map((inference) => ({
            id: nativeRuntimeQualificationCaseId({
              providerId,
              agent,
              architecture,
              acceleration,
              inference,
            }),
            agent,
            architecture,
            acceleration,
            inference,
            platform: "linux" as const,
            rootMode: "rootless" as const,
            capabilities,
            gate: "protected-e2e" as const,
            install: "release-installer" as const,
            dockerAvailability: "unavailable" as const,
            obligations: NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
            evidenceKinds: requiredNativeRuntimeQualificationEvidenceKinds(acceleration),
          })),
        ),
      ),
    ),
  };
}

export const PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION =
  compileNativeRuntimeQualification(nativeRuntimeQualificationDefinition("podman"));

function validatedArtifactReceipt(
  value: unknown,
  label: string,
  readReceipt: NativeRuntimeQualificationReceiptReader,
): NativeRuntimeQualificationArtifactReceipt {
  const artifact = record(value, label);
  exactKeys(artifact, ["path", "sha256"], label);
  const artifactPath = singleLine(artifact.path, `${label} path`);
  if (
    !ARTIFACT_PATH.test(artifactPath) ||
    artifactPath.startsWith("/") ||
    artifactPath.startsWith("-") ||
    artifactPath.includes("//") ||
    artifactPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} path must be a safe repository-relative path`);
  }
  if (typeof artifact.sha256 !== "string" || !ARTIFACT_SHA256.test(artifact.sha256)) {
    throw new Error(`${label} sha256 must be an exact lowercase SHA-256 digest`);
  }
  const contents = readReceipt(artifactPath);
  if (contents === null) {
    throw new Error(
      `${label} receipt '${artifactPath}' is missing from the authenticated artifact`,
    );
  }
  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== artifact.sha256) {
    throw new Error(`${label} receipt '${artifactPath}' does not match its SHA-256 digest`);
  }
  return Object.freeze({ path: artifactPath, sha256: artifact.sha256 });
}

function validatedExpectedSource(
  value: unknown,
  definition: NativeRuntimeQualificationDefinition,
): NativeRuntimeQualificationExpectedSource {
  const source = record(value, "Native runtime qualification expected source");
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
    "Native runtime qualification expected source",
  );
  const repository = singleLine(source.repository, "Expected repository");
  const workflow = singleLine(source.workflow, "Expected protected workflow");
  const candidateRepository = singleLine(
    source.candidateRepository,
    "Expected candidate repository",
  );
  if (
    repository !== definition.repository ||
    !REPOSITORY.test(repository) ||
    !REPOSITORY.test(candidateRepository) ||
    !WORKFLOW.test(workflow) ||
    source.baseRef !== "main" ||
    typeof source.headSha !== "string" ||
    !SOURCE_REVISION.test(source.headSha) ||
    typeof source.baseSha !== "string" ||
    !SOURCE_REVISION.test(source.baseSha) ||
    source.headSha === source.baseSha
  ) {
    throw new Error("Native runtime qualification expected source identity is invalid");
  }
  const artifact = record(source.artifact, "Expected GitHub artifact");
  exactKeys(artifact, ["id", "name", "digest"], "Expected GitHub artifact");
  const artifactName = singleLine(artifact.name, "Expected GitHub artifact name");
  if (
    !ARTIFACT_NAME.test(artifactName) ||
    typeof artifact.digest !== "string" ||
    !SOURCE_DIGEST.test(artifact.digest)
  ) {
    throw new Error("Expected GitHub artifact identity is invalid");
  }
  return Object.freeze({
    repository,
    workflow,
    pullRequestNumber: positiveInteger(source.pullRequestNumber, "Expected pull request number"),
    candidateRepository,
    headSha: source.headSha,
    baseRef: "main",
    baseSha: source.baseSha,
    runId: positiveInteger(source.runId, "Expected protected run id"),
    attempt: positiveInteger(source.attempt, "Expected protected run attempt"),
    jobId: positiveInteger(source.jobId, "Expected protected job id"),
    artifact: Object.freeze({
      id: positiveInteger(artifact.id, "Expected GitHub artifact id"),
      name: artifactName,
      digest: artifact.digest,
    }),
  });
}

function assertProtectedRun(
  value: unknown,
  expected: NativeRuntimeQualificationExpectedSource,
  label: string,
): void {
  const source = record(value, `${label} protected run`);
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
    ],
    `${label} protected run`,
  );
  if (
    source.repository !== expected.repository ||
    source.workflow !== expected.workflow ||
    source.pullRequestNumber !== expected.pullRequestNumber ||
    source.candidateRepository !== expected.candidateRepository ||
    source.headSha !== expected.headSha ||
    source.baseRef !== expected.baseRef ||
    source.baseSha !== expected.baseSha ||
    source.runId !== expected.runId ||
    source.attempt !== expected.attempt ||
    source.jobId !== expected.jobId
  ) {
    throw new Error(`${label} does not match the externally expected protected source`);
  }
}

function assertInstallerEvidence(
  value: unknown,
  definition: NativeRuntimeQualificationDefinition,
  qualificationCase: NativeRuntimeQualificationCase,
  label: string,
  readReceipt: NativeRuntimeQualificationReceiptReader,
): void {
  const installer = record(value, `${label} installer`);
  exactKeys(
    installer,
    ["providerId", "architecture", "dockerAvailability", "exitCode", "invocation", "script"],
    `${label} installer`,
  );
  if (
    installer.providerId !== definition.providerId ||
    installer.architecture !== qualificationCase.architecture ||
    installer.dockerAvailability !== "unavailable" ||
    installer.exitCode !== 0
  ) {
    throw new Error(`${label} has an invalid installer receipt`);
  }
  validatedArtifactReceipt(installer.invocation, `${label} installer invocation`, readReceipt);
  validatedArtifactReceipt(installer.script, `${label} installer script`, readReceipt);
}

function assertRuntimeEvidence(
  value: unknown,
  definition: NativeRuntimeQualificationDefinition,
  qualificationCase: NativeRuntimeQualificationCase,
  label: string,
  readReceipt: NativeRuntimeQualificationReceiptReader,
): void {
  const runtime = record(value, `${label} runtime`);
  exactKeys(
    runtime,
    [
      "providerId",
      "agent",
      "inference",
      "architecture",
      "acceleration",
      "rootMode",
      "engineName",
      "engineVersion",
      "managedImages",
      "result",
    ],
    `${label} runtime`,
  );
  if (
    runtime.providerId !== definition.providerId ||
    runtime.agent !== qualificationCase.agent ||
    runtime.inference !== qualificationCase.inference ||
    runtime.architecture !== qualificationCase.architecture ||
    runtime.acceleration !== qualificationCase.acceleration ||
    runtime.rootMode !== qualificationCase.rootMode
  ) {
    throw new Error(`${label} has an invalid runtime identity`);
  }
  singleLine(runtime.engineName, `${label} runtime engine name`);
  singleLine(runtime.engineVersion, `${label} runtime engine version`);
  if (!Array.isArray(runtime.managedImages) || runtime.managedImages.length === 0) {
    throw new Error(`${label} must name exact managed images`);
  }
  const roles = new Set<string>();
  for (const value of runtime.managedImages) {
    const image = record(value, `${label} managed image`);
    exactKeys(image, ["role", "digest"], `${label} managed image`);
    const role = singleLine(image.role, `${label} managed image role`);
    if (roles.has(role) || typeof image.digest !== "string" || !SOURCE_DIGEST.test(image.digest)) {
      throw new Error(`${label} must use unique roles and exact managed-image digests`);
    }
    roles.add(role);
  }
  validatedArtifactReceipt(runtime.result, `${label} runtime result`, readReceipt);
}

function assertOperationEvidence(
  value: unknown,
  qualificationCase: NativeRuntimeQualificationCase,
  label: string,
  readReceipt: NativeRuntimeQualificationReceiptReader,
): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label} operations must be an array`);
  }
  const operations = value.map((entry) => record(entry, `${label} operation`));
  const operationIds = operations
    .map((operation) => operation.id)
    .filter(
      (operation): operation is NativeRuntimeQualificationObligation =>
        typeof operation === "string",
    );
  exactSet(operationIds, qualificationCase.obligations, `${label} operations`);
  if (operationIds.length !== operations.length) {
    throw new Error(`${label} operations contain an invalid obligation`);
  }
  operations.forEach((operation, index) => {
    exactKeys(operation, ["id", "artifact"], `${label} operation`);
    validatedArtifactReceipt(
      operation.artifact,
      `${label} operation '${String(operationIds[index])}'`,
      readReceipt,
    );
  });
}

function assertCaseEvidence(
  value: unknown,
  definition: NativeRuntimeQualificationDefinition,
  qualificationCase: NativeRuntimeQualificationCase,
  expected: NativeRuntimeQualificationExpectedSource,
  readReceipt: NativeRuntimeQualificationReceiptReader,
): void {
  const label = `Native runtime qualification case '${qualificationCase.id}'`;
  const evidence = record(value, label);
  const gpu = qualificationCase.acceleration === "nvidia-gpu";
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "caseId",
      "protectedRun",
      "installer",
      "runtime",
      "operations",
      ...(gpu ? ["nvidiaCdi"] : []),
    ],
    label,
  );
  if (evidence.schemaVersion !== 1 || evidence.caseId !== qualificationCase.id) {
    throw new Error(`${label} identity is invalid`);
  }
  assertProtectedRun(evidence.protectedRun, expected, label);
  assertInstallerEvidence(evidence.installer, definition, qualificationCase, label, readReceipt);
  assertRuntimeEvidence(evidence.runtime, definition, qualificationCase, label, readReceipt);
  assertOperationEvidence(evidence.operations, qualificationCase, label, readReceipt);
  if (gpu) {
    const cdi = record(evidence.nvidiaCdi, `${label} NVIDIA CDI`);
    exactKeys(cdi, ["device", "artifact"], `${label} NVIDIA CDI`);
    if (cdi.device !== "nvidia.com/gpu=all") {
      throw new Error(`${label} must prove NVIDIA CDI access`);
    }
    validatedArtifactReceipt(cdi.artifact, `${label} NVIDIA CDI`, readReceipt);
  }
}

/**
 * Consume one aggregate evidence artifact only after a trusted controller has
 * resolved its expected GitHub identities independently from the artifact.
 */
export function consumeNativeRuntimeQualificationEvidence(
  definition: NativeRuntimeQualificationDefinition,
  value: unknown,
  expectedSource: NativeRuntimeQualificationExpectedSource,
  readReceipt: NativeRuntimeQualificationReceiptReader,
): NativeRuntimeQualificationAuthority {
  if (!compiledNativeRuntimeQualifications.has(definition)) {
    throw new Error("Native runtime qualification evidence requires a compiled definition");
  }
  const expected = validatedExpectedSource(expectedSource, definition);
  const envelope = record(value, "Native runtime qualification evidence");
  exactKeys(
    envelope,
    ["schemaVersion", "qualificationId", "providerId", "cases"],
    "Native runtime qualification evidence",
  );
  if (
    envelope.schemaVersion !== 1 ||
    envelope.qualificationId !== definition.id ||
    envelope.providerId !== definition.providerId ||
    !Array.isArray(envelope.cases)
  ) {
    throw new Error("Native runtime qualification evidence identity is invalid");
  }
  const casesById = new Map(definition.cases.map((entry) => [entry.id, entry]));
  const evidenceById = new Map<string, unknown>();
  for (const entry of envelope.cases) {
    const evidence = record(entry, "Native runtime qualification case evidence");
    if (typeof evidence.caseId !== "string" || evidenceById.has(evidence.caseId)) {
      throw new Error("Native runtime qualification evidence repeats or omits a case identity");
    }
    const qualificationCase = casesById.get(evidence.caseId);
    if (!qualificationCase) {
      throw new Error(
        `Native runtime qualification evidence names unknown case '${evidence.caseId}'`,
      );
    }
    assertCaseEvidence(evidence, definition, qualificationCase, expected, readReceipt);
    evidenceById.set(evidence.caseId, evidence);
  }
  const missing = definition.cases.filter((entry) => !evidenceById.has(entry.id));
  if (missing.length > 0 || evidenceById.size !== definition.cases.length) {
    throw new Error(
      `Native runtime qualification evidence is incomplete: ${missing
        .map((entry) => entry.id)
        .join(", ")}`,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    qualificationId: definition.id,
    providerId: definition.providerId,
    source: expected,
  });
}

/**
 * Consume only the current credential-free candidate prerequisites. This does
 * not issue protected qualification evidence or activate a runtime provider.
 */
export function consumeNativeRuntimeCandidateEvidence(
  value: unknown,
  expectedSourceRevision: string,
): NativeRuntimeCandidateAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Native runtime candidate evidence is incomplete or does not match source");
  }
  const candidate = value as Partial<NativeRuntimeCandidateEvidence>;
  const shaped =
    Array.isArray(candidate.agents) &&
    candidate.agents.every((agent) => typeof agent === "string") &&
    typeof candidate.dockerUnavailable === "object" &&
    candidate.dockerUnavailable !== null &&
    !Array.isArray(candidate.dockerUnavailable);
  if (
    !shaped ||
    candidate.schemaVersion !== 1 ||
    candidate.claim !== "candidate-execution-prerequisites" ||
    candidate.candidateId !== "podman-cpu-lifecycle" ||
    typeof candidate.providerId !== "string" ||
    !PROVIDER_ID.test(candidate.providerId) ||
    candidate.executionPath !== "runtime-provider-bundle" ||
    candidate.architecture !== "amd64" ||
    candidate.acceleration !== "cpu" ||
    candidate.socketFree !== true ||
    typeof candidate.sourceRevision !== "string" ||
    !SOURCE_REVISION.test(candidate.sourceRevision) ||
    candidate.sourceRevision !== expectedSourceRevision ||
    candidate.dockerUnavailable?.service !== true ||
    candidate.dockerUnavailable.socket !== true ||
    candidate.dockerUnavailable.daemon !== true ||
    candidate.dockerUnavailable.invocationGuard !== true
  ) {
    throw new Error("Native runtime candidate evidence is incomplete or does not match source");
  }
  exactSet(
    candidate.agents,
    NATIVE_RUNTIME_QUALIFICATION_AGENTS,
    "Native runtime candidate agents",
  );
  return Object.freeze({
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    providerId: candidate.providerId,
    sourceRevision: candidate.sourceRevision,
    executionPath: candidate.executionPath,
  });
}
