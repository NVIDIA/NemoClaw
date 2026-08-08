// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import {
  expandQualificationMatrix,
  QUALIFICATION_MAX_AGGREGATE_CELL_BYTES,
  QUALIFICATION_MAX_AGGREGATE_MATRIX_CELLS,
  type QualificationCellResult,
  qualificationCellInventoryFootprint,
  requireCompleteQualificationMatrix,
  validateQualificationApprovedExceptions,
  validateQualificationCellResults,
  validateQualificationMatrix,
} from "./openshell-qualification-matrix.mts";
import {
  type ActiveQualificationTestDescriptor,
  type CreateQualificationReceiptInput,
  type ProduceQualificationReceiptInput,
  QUALIFICATION_CONTRACT_PATH,
  QUALIFICATION_CONTRACT_SCHEMA_VERSION,
  QUALIFICATION_MAX_ARTIFACT_BYTES,
  QUALIFICATION_MAX_JSON_BYTES,
  QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA,
  QUALIFICATION_PUBLIC_USER_BASELINE_COMMIT_SHA,
  QUALIFICATION_PUBLIC_USER_BASELINE_TAG,
  QUALIFICATION_PUBLIC_USER_BASELINE_VERSION,
  QUALIFICATION_RECEIPT_FILE,
  QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA,
  QUALIFICATION_REPOSITORY_BASELINE_TAG,
  QUALIFICATION_REPOSITORY_BASELINE_VERSION,
  QUALIFICATION_REQUIRED_WORKFLOW_PATH,
  QUALIFICATION_REQUIRED_WORKFLOW_REF,
  QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID,
  QUALIFICATION_RETIREMENT_TAG_MESSAGE_PREFIX,
  QUALIFICATION_SCOPE,
  QUALIFICATION_SOURCE_RECEIPT_FILE,
  QUALIFICATION_TARGET_COMMIT_SHA,
  QUALIFICATION_TARGET_TAG,
  QUALIFICATION_TARGET_VERSION,
  type QualificationArtifactProvenance,
  type QualificationArtifactReader,
  type QualificationContract,
  type QualificationExecutionContext,
  type QualificationGitHubReader,
  type QualificationIdentity,
  type QualificationInventoryState,
  type QualificationLifecycle,
  type QualificationPhase,
  type QualificationPhaseMapping,
  type QualificationReceipt,
  type QualificationReceiptExpectation,
  type QualificationReceiptJob,
  type QualificationReceiptRun,
  type QualificationReceiptTest,
  type QualificationRequiredWorkflowGate,
  type QualificationResult,
  type QualificationRetirementEvidence,
  type QualificationRetirementTagMetadata,
  type QualificationSource,
  type QualificationSourceEvent,
  type QualificationTestDescriptor,
} from "./openshell-qualification-schema.mts";

export * from "./openshell-qualification-schema.mts";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/u;
const TEST_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const REPOSITORY_PATH_PATTERN = /^[^\u0000-\u001f\u007f\\]{1,4096}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]{1,2048}$/u;
export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_ITEMS = 100_000;
const MAX_TESTS = 128;
export const MAX_AUTHORITY_PATHS = MAX_TESTS * MAX_TESTS * 2 + 128;
export const MAX_GITHUB_JSON_BYTES = 16 * 1024 * 1024;
const REQUIRED_ARTIFACT_COMPONENTS = new Set([
  "checksum-manifest",
  "cli",
  "gateway",
  "package",
  "sandbox-binary",
  "supervisor-image",
  "virtual-machine-driver",
]);

export const QUALIFICATION_FROZEN_AUTHORITY_PATHS = [
  ".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md",
  ".github/workflows/openshell-0.0.101-pr-gate.yaml",
  ".github/workflows/openshell-0.0.101-qualification.yaml",
  "scripts/checks/openshell-qualification-contract.mts",
  "scripts/checks/openshell-qualification-core.mts",
  "scripts/checks/openshell-qualification-github.mts",
  "scripts/checks/openshell-qualification-io.mts",
  "scripts/checks/openshell-qualification-matrix.mts",
  "scripts/checks/openshell-qualification-paths.mts",
  "scripts/checks/openshell-qualification-schema.mts",
  "scripts/checks/verify-openshell-qualification-producer-workflow.mts",
  "scripts/checks/verify-openshell-qualification-pr-gate.mts",
  "scripts/release-cut-tag.sh",
  "scripts/scorecard/read-artifact-zip.mts",
] as const;

export function qualificationAuthorityPaths(
  contract: QualificationContract,
  includeContract = false,
): string[] {
  const authority = new Set<string>(QUALIFICATION_FROZEN_AUTHORITY_PATHS);
  if (includeContract) authority.add(QUALIFICATION_CONTRACT_PATH);
  authority.add(contract.trustedProducerWorkflowPath);
  authority.add(contract.requiredWorkflowGate?.sourcePath ?? "");
  authority.delete("");
  for (const test of contract.tests) {
    for (const mapping of Object.values(test.mappings)) {
      if (!mapping?.source) continue;
      authority.add(mapping.source.workflowPath);
      for (const authorityPath of mapping.source.authorityPaths) authority.add(authorityPath);
    }
  }
  return [...authority].sort();
}

const CONTRACT_KEYS = [
  "artifacts",
  "nemoclawRepositoryBaselineSha",
  "nemoclawUserBaselineCommitSha",
  "nemoclawUserBaselineTag",
  "nemoclawUserBaselineTagObjectSha",
  "openshellRepositoryBaselineCommitSha",
  "openshellRepositoryBaselineTag",
  "openshellRepositoryBaselineVersion",
  "openshellBaselineCommitSha",
  "openshellBaselineTag",
  "openshellBaselineVersion",
  "openshellTargetCommitSha",
  "openshellTargetTag",
  "openshellTargetVersion",
  "inventoryState",
  "lifecycle",
  "repository",
  "requiredWorkflowGate",
  "retirementEvidence",
  "schemaVersion",
  "scope",
  "requiredStatusRulesetId",
  "tests",
  "trustedProducerWorkflowPath",
] as const;

const IDENTITY_KEYS = [
  "nemoclawRepositoryBaselineSha",
  "nemoclawUserBaselineCommitSha",
  "nemoclawUserBaselineTag",
  "nemoclawUserBaselineTagObjectSha",
  "openshellRepositoryBaselineCommitSha",
  "openshellRepositoryBaselineTag",
  "openshellRepositoryBaselineVersion",
  "openshellBaselineCommitSha",
  "openshellBaselineTag",
  "openshellBaselineVersion",
  "openshellTargetCommitSha",
  "openshellTargetTag",
  "openshellTargetVersion",
] as const;

const RECEIPT_KEYS = [
  ...IDENTITY_KEYS,
  "artifacts",
  "baseSha",
  "candidateSha",
  "executionContext",
  "lifecycle",
  "phase",
  "prNumber",
  "repository",
  "schemaVersion",
  "scope",
  "tests",
  "trustedProducerRunAttempt",
  "trustedProducerRunId",
  "trustedProducerRunUrl",
  "trustedProducerWorkflowPath",
  "trustedProducerWorkflowSha",
] as const;

export function fail(message: string): never {
  throw new Error(`OpenShell qualification contract failed: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has an unexpected schema`);
  }
}

export function validateSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

const RETIREMENT_TAG_METADATA_KEYS = [
  "finalContractSha256",
  "finalReceiptSha256",
  "releaseBaseSha",
  "releaseCandidateSha",
  "releaseTag",
  "schemaVersion",
  "scope",
  "trustedProducerRunAttempt",
  "trustedProducerRunId",
  "trustedProducerWorkflowSha",
] as const;

export function validateQualificationRetirementTagMetadata(
  value: unknown,
): QualificationRetirementTagMetadata {
  if (!isRecord(value)) fail("qualification retirement tag metadata is not an object");
  assertExactKeys(value, RETIREMENT_TAG_METADATA_KEYS, "qualification retirement tag metadata");
  if (value.schemaVersion !== QUALIFICATION_CONTRACT_SCHEMA_VERSION) {
    fail("qualification retirement tag metadata schemaVersion is unsupported");
  }
  if (value.scope !== QUALIFICATION_SCOPE) {
    fail("qualification retirement tag metadata scope is unsupported");
  }
  if (typeof value.releaseTag !== "string" || !TAG_PATTERN.test(value.releaseTag)) {
    fail("qualification retirement release tag is invalid");
  }
  if (
    typeof value.finalContractSha256 !== "string" ||
    !SHA256_PATTERN.test(value.finalContractSha256) ||
    typeof value.finalReceiptSha256 !== "string" ||
    !SHA256_PATTERN.test(value.finalReceiptSha256)
  ) {
    fail("qualification retirement evidence digest is invalid");
  }
  const releaseBaseSha = validateSha(
    value.releaseBaseSha,
    "qualification retirement release base SHA",
  );
  const releaseCandidateSha = validateSha(
    value.releaseCandidateSha,
    "qualification retirement release candidate SHA",
  );
  const trustedProducerWorkflowSha = validateSha(
    value.trustedProducerWorkflowSha,
    "qualification retirement producer workflow SHA",
  );
  if (releaseCandidateSha !== trustedProducerWorkflowSha) {
    fail("qualification retirement producer workflow SHA does not match the release candidate");
  }
  if (
    typeof value.trustedProducerRunId !== "string" ||
    !RUN_ID_PATTERN.test(value.trustedProducerRunId) ||
    !positiveInteger(value.trustedProducerRunAttempt)
  ) {
    fail("qualification retirement producer run identity is invalid");
  }
  return {
    finalContractSha256: value.finalContractSha256,
    finalReceiptSha256: value.finalReceiptSha256,
    releaseBaseSha,
    releaseCandidateSha,
    releaseTag: value.releaseTag,
    schemaVersion: QUALIFICATION_CONTRACT_SCHEMA_VERSION,
    scope: QUALIFICATION_SCOPE,
    trustedProducerRunAttempt: value.trustedProducerRunAttempt,
    trustedProducerRunId: value.trustedProducerRunId,
    trustedProducerWorkflowSha,
  };
}

export function validateQualificationRetirementEvidence(
  value: unknown,
): QualificationRetirementEvidence {
  if (!isRecord(value)) fail("qualification retirement evidence is not an object");
  assertExactKeys(
    value,
    [...RETIREMENT_TAG_METADATA_KEYS, "releaseTagObjectSha"],
    "qualification retirement evidence",
  );
  const releaseTagObjectSha = validateSha(
    value.releaseTagObjectSha,
    "qualification retirement release tag object SHA",
  );
  const { releaseTagObjectSha: _releaseTagObjectSha, ...metadataValue } = value;
  return {
    ...validateQualificationRetirementTagMetadata(metadataValue),
    releaseTagObjectSha,
  };
}

export function renderQualificationRetirementTagMessage(
  value: QualificationRetirementTagMetadata | unknown,
): string {
  const metadata = validateQualificationRetirementTagMetadata(value);
  return `${metadata.releaseTag}\n\n${QUALIFICATION_RETIREMENT_TAG_MESSAGE_PREFIX}${JSON.stringify(metadata)}`;
}

function validateRequiredWorkflowGate(value: unknown): QualificationRequiredWorkflowGate {
  if (!isRecord(value)) fail("qualification required workflow gate is not an object");
  assertExactKeys(
    value,
    ["organizationRulesetId", "repositoryId", "sourcePath", "sourceRef"],
    "qualification required workflow gate",
  );
  if (
    !positiveInteger(value.organizationRulesetId) ||
    value.repositoryId !== QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID ||
    value.sourcePath !== QUALIFICATION_REQUIRED_WORKFLOW_PATH ||
    value.sourceRef !== QUALIFICATION_REQUIRED_WORKFLOW_REF
  ) {
    fail("qualification required workflow gate authority is invalid");
  }
  return {
    organizationRulesetId: value.organizationRulesetId,
    repositoryId: QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID,
    sourcePath: QUALIFICATION_REQUIRED_WORKFLOW_PATH,
    sourceRef: QUALIFICATION_REQUIRED_WORKFLOW_REF,
  };
}

export function validateRepository(value: unknown): string {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) {
    fail("repository is invalid");
  }
  return value;
}

export function validatePhase(value: unknown): QualificationPhase {
  if (value !== "selector" && value !== "final") fail("phase must be selector or final");
  return value;
}

export function validateExecutionContext(value: unknown): QualificationExecutionContext {
  if (value !== "selector" && value !== "final-promotion" && value !== "release") {
    fail("qualification execution context is invalid");
  }
  return value;
}

export function validatePhaseExecutionContext(
  phase: QualificationPhase,
  executionContext: QualificationExecutionContext,
): void {
  if (
    (executionContext === "selector" && phase !== "selector") ||
    (executionContext !== "selector" && phase !== "final")
  ) {
    fail("qualification receipt phase and execution context are incompatible");
  }
}

function validateLifecycle(value: unknown): QualificationLifecycle {
  if (value !== "bootstrap" && value !== "selector" && value !== "final" && value !== "retired") {
    fail("qualification lifecycle is invalid");
  }
  return value;
}

function validateInventoryState(value: unknown): QualificationInventoryState {
  if (value !== "draft" && value !== "frozen") {
    fail("qualification inventory state must be draft or frozen");
  }
  return value;
}

export function validateSourceEvent(value: unknown): QualificationSourceEvent {
  if (value !== "pull_request" && value !== "push" && value !== "workflow_dispatch") {
    fail("qualification source event is invalid");
  }
  return value;
}

export function validateRepositoryPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !REPOSITORY_PATH_PATTERN.test(value)) {
    fail(`${label} is invalid`);
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path.posix.normalize(value) !== value
  ) {
    fail(`${label} is not a canonical repository-relative path`);
  }
  return value;
}

export function validateWorkflowPath(value: unknown): string {
  if (typeof value !== "string" || !WORKFLOW_PATH_PATTERN.test(value)) {
    fail("trusted producer workflow path is invalid");
  }
  return value;
}

function validateIdentity(value: Record<string, unknown>): QualificationIdentity {
  const nemoclawRepositoryBaselineSha = validateSha(
    value.nemoclawRepositoryBaselineSha,
    "NemoClaw repository baseline SHA",
  );
  const nemoclawUserBaselineCommitSha = validateSha(
    value.nemoclawUserBaselineCommitSha,
    "NemoClaw user baseline commit SHA",
  );
  const nemoclawUserBaselineTagObjectSha = validateSha(
    value.nemoclawUserBaselineTagObjectSha,
    "NemoClaw user baseline tag object SHA",
  );
  const openshellRepositoryBaselineCommitSha = validateSha(
    value.openshellRepositoryBaselineCommitSha,
    "OpenShell repository baseline commit SHA",
  );
  const openshellBaselineCommitSha = validateSha(
    value.openshellBaselineCommitSha,
    "OpenShell baseline commit SHA",
  );
  const openshellTargetCommitSha = validateSha(
    value.openshellTargetCommitSha,
    "OpenShell target commit SHA",
  );
  if (
    typeof value.nemoclawUserBaselineTag !== "string" ||
    !TAG_PATTERN.test(value.nemoclawUserBaselineTag)
  ) {
    fail("NemoClaw user baseline tag is invalid");
  }
  if (
    typeof value.openshellBaselineVersion !== "string" ||
    !SEMVER_PATTERN.test(value.openshellBaselineVersion) ||
    typeof value.openshellTargetVersion !== "string" ||
    !SEMVER_PATTERN.test(value.openshellTargetVersion) ||
    typeof value.openshellBaselineTag !== "string" ||
    value.openshellBaselineTag !== `v${value.openshellBaselineVersion}` ||
    typeof value.openshellTargetTag !== "string" ||
    value.openshellTargetTag !== `v${value.openshellTargetVersion}` ||
    typeof value.openshellRepositoryBaselineVersion !== "string" ||
    !SEMVER_PATTERN.test(value.openshellRepositoryBaselineVersion) ||
    typeof value.openshellRepositoryBaselineTag !== "string" ||
    value.openshellRepositoryBaselineTag !== `v${value.openshellRepositoryBaselineVersion}` ||
    value.openshellRepositoryBaselineVersion === value.openshellTargetVersion ||
    value.openshellBaselineVersion === value.openshellTargetVersion
  ) {
    fail("OpenShell baseline or target version identity is invalid");
  }
  if (
    nemoclawRepositoryBaselineSha !== QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA ||
    value.nemoclawUserBaselineTag !== QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG ||
    nemoclawUserBaselineTagObjectSha !== QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA ||
    nemoclawUserBaselineCommitSha !== QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA
  ) {
    fail("NemoClaw repository or public-user baseline identity is not approved");
  }
  if (
    value.openshellRepositoryBaselineVersion !== QUALIFICATION_REPOSITORY_BASELINE_VERSION ||
    value.openshellRepositoryBaselineTag !== QUALIFICATION_REPOSITORY_BASELINE_TAG ||
    openshellRepositoryBaselineCommitSha !== QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA ||
    value.openshellBaselineVersion !== QUALIFICATION_PUBLIC_USER_BASELINE_VERSION ||
    value.openshellBaselineTag !== QUALIFICATION_PUBLIC_USER_BASELINE_TAG ||
    openshellBaselineCommitSha !== QUALIFICATION_PUBLIC_USER_BASELINE_COMMIT_SHA ||
    value.openshellTargetVersion !== QUALIFICATION_TARGET_VERSION ||
    value.openshellTargetTag !== QUALIFICATION_TARGET_TAG ||
    openshellTargetCommitSha !== QUALIFICATION_TARGET_COMMIT_SHA
  ) {
    fail("OpenShell repository, public-user baseline, or target identity is not approved");
  }
  return {
    nemoclawRepositoryBaselineSha,
    nemoclawUserBaselineCommitSha,
    nemoclawUserBaselineTag: value.nemoclawUserBaselineTag,
    nemoclawUserBaselineTagObjectSha,
    openshellRepositoryBaselineCommitSha,
    openshellRepositoryBaselineTag: value.openshellRepositoryBaselineTag,
    openshellRepositoryBaselineVersion: value.openshellRepositoryBaselineVersion,
    openshellBaselineCommitSha,
    openshellBaselineTag: value.openshellBaselineTag,
    openshellBaselineVersion: value.openshellBaselineVersion,
    openshellTargetCommitSha,
    openshellTargetTag: value.openshellTargetTag,
    openshellTargetVersion: value.openshellTargetVersion,
  };
}

export function validateTokenArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    fail(`${label} must be a nonempty bounded array`);
  }
  const result = value.map((entry) => {
    if (typeof entry !== "string" || !TOKEN_PATTERN.test(entry)) {
      fail(`${label} contains an invalid token`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) fail(`${label} contains a duplicate token`);
  return result;
}

export function validateStringArray(
  value: unknown,
  label: string,
  validateEntry: (entry: unknown, entryLabel: string) => string,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TESTS) {
    fail(`${label} must be a nonempty bounded array`);
  }
  const result = value.map((entry) => validateEntry(entry, label));
  if (new Set(result).size !== result.length) fail(`${label} contains a duplicate value`);
  return result;
}

function validateArtifactUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_TEXT_PATTERN.test(value)) fail(`${label} is invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(`${label} is not an immutable HTTPS artifact URL`);
  }
  return value;
}

function validateArtifactProvenance(
  value: unknown,
  index: number,
): QualificationArtifactProvenance {
  const label = `qualification artifact[${index}]`;
  if (!isRecord(value)) fail(`${label} is not an object`);
  assertExactKeys(value, ["component", "consumers", "name", "sha256", "url"], label);
  if (typeof value.component !== "string" || !TOKEN_PATTERN.test(value.component)) {
    fail(`${label} component is invalid`);
  }
  if (typeof value.name !== "string" || !SAFE_TEXT_PATTERN.test(value.name)) {
    fail(`${label} name is invalid`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    fail(`${label} sha256 is invalid`);
  }
  return {
    component: value.component,
    consumers: validateStringArray(value.consumers, `${label} consumers`, validateRepositoryPath),
    name: value.name,
    sha256: value.sha256,
    url: validateArtifactUrl(value.url, `${label} url`),
  };
}

export function validateArtifacts(value: unknown): QualificationArtifactProvenance[] {
  if (!Array.isArray(value) || value.length > MAX_TESTS) {
    fail("qualification artifacts must be a bounded array");
  }
  const artifacts = value.map(validateArtifactProvenance);
  const identities = artifacts.map((entry) => `${entry.component}\u0000${entry.name}`);
  if (new Set(identities).size !== identities.length) {
    fail("qualification artifacts contain duplicated component/name identities");
  }
  return artifacts;
}

function requireCompleteArtifacts(artifacts: QualificationArtifactProvenance[]): void {
  const components = new Set(artifacts.map((entry) => entry.component));
  for (const component of REQUIRED_ARTIFACT_COMPONENTS) {
    if (!components.has(component)) {
      fail(`qualification frozen artifact inventory is missing ${component}`);
    }
  }
}

function validateQualificationSource(
  value: unknown,
  testId: string,
  phase: QualificationPhase,
): QualificationSource {
  if (!isRecord(value)) fail(`qualification test ${testId} ${phase} source is not an object`);
  assertExactKeys(
    value,
    ["aggregation", "authorityPaths", "event", "jobNames", "workflowId", "workflowPath"],
    `qualification test ${testId} ${phase} source mapping`,
  );
  if (value.aggregation !== "all") {
    fail(`qualification test ${testId} ${phase} source aggregation is unsupported`);
  }
  const event = validateSourceEvent(value.event);
  if (
    (phase === "selector" && event === "push") ||
    (phase === "final" && event === "pull_request")
  ) {
    fail(`qualification test ${testId} ${phase} source event is unsupported`);
  }
  const workflowPath = validateWorkflowPath(value.workflowPath);
  const authorityPaths = validateStringArray(
    value.authorityPaths,
    `qualification test ${testId} ${phase} authorityPaths`,
    validateRepositoryPath,
  );
  if (!authorityPaths.includes(workflowPath)) {
    fail(`qualification test ${testId} ${phase} authorityPaths omit the workflow path`);
  }
  const jobNames = validateStringArray(
    value.jobNames,
    `qualification test ${testId} ${phase} jobNames`,
    (entry, label) => {
      if (typeof entry !== "string" || !SAFE_TEXT_PATTERN.test(entry)) {
        fail(`${label} contains an invalid job name`);
      }
      return entry;
    },
  );
  if (!positiveInteger(value.workflowId)) {
    fail(`qualification test ${testId} ${phase} workflowId is invalid`);
  }
  return {
    aggregation: "all",
    authorityPaths,
    event,
    jobNames,
    workflowId: value.workflowId,
    workflowPath,
  };
}

function validatePhaseMapping(
  value: unknown,
  testId: string,
  phase: QualificationPhase,
): QualificationPhaseMapping {
  if (!isRecord(value)) fail(`qualification test ${testId} ${phase} mapping is not an object`);
  assertExactKeys(value, ["source", "status"], `qualification test ${testId} ${phase} mapping`);
  if (value.status === "pending") {
    return {
      source:
        value.source === null ? null : validateQualificationSource(value.source, testId, phase),
      status: "pending",
    };
  }
  if (value.status !== "active") {
    fail(`qualification test ${testId} ${phase} mapping has an invalid status`);
  }
  return {
    source: validateQualificationSource(value.source, testId, phase),
    status: "active",
  };
}

function validateTestDescriptor(value: unknown): QualificationTestDescriptor {
  if (!isRecord(value)) fail("qualification test descriptor is not an object");
  assertExactKeys(
    value,
    [
      "approvedExceptions",
      "id",
      "mappings",
      "matrix",
      "ownerIssues",
      "phases",
      "requiredCases",
      "requiredDimensions",
    ],
    "qualification test descriptor",
  );
  if (typeof value.id !== "string" || !TEST_ID_PATTERN.test(value.id)) {
    fail("qualification test descriptor id is invalid");
  }
  const testId = value.id;
  if (!Array.isArray(value.ownerIssues) || value.ownerIssues.length === 0) {
    fail(`qualification test ${value.id} has no owner issue`);
  }
  const ownerIssues = value.ownerIssues.map((entry) => {
    if (!positiveInteger(entry)) fail(`qualification test ${value.id} has an invalid owner issue`);
    return entry;
  });
  if (new Set(ownerIssues).size !== ownerIssues.length) {
    fail(`qualification test ${value.id} has a duplicated owner issue`);
  }
  if (!Array.isArray(value.phases) || value.phases.length === 0 || value.phases.length > 2) {
    fail(`qualification test ${value.id} has invalid phases`);
  }
  const phases = value.phases.map(validatePhase);
  if (new Set(phases).size !== phases.length || phases[0] !== "selector") {
    fail(`qualification test ${value.id} phases must be unique and start with selector`);
  }
  const mappingsValue = value.mappings;
  if (!isRecord(mappingsValue)) {
    fail(`qualification test ${testId} mappings are not an object`);
  }
  assertExactKeys(mappingsValue, ["selector", "final"], `qualification test ${testId} mappings`);
  const mappings = Object.fromEntries(
    (["selector", "final"] as const).map((phase) => [
      phase,
      validatePhaseMapping(mappingsValue[phase], testId, phase),
    ]),
  ) as Partial<Record<QualificationPhase, QualificationPhaseMapping>>;
  const matrix = validateQualificationMatrix(value.matrix, testId);
  return {
    approvedExceptions: validateQualificationApprovedExceptions(
      value.approvedExceptions,
      matrix,
      "NVIDIA/NemoClaw",
      testId,
    ),
    id: testId,
    mappings,
    matrix,
    ownerIssues,
    phases,
    requiredCases: validateTokenArray(
      value.requiredCases,
      `qualification test ${value.id} requiredCases`,
    ),
    requiredDimensions: validateTokenArray(
      value.requiredDimensions,
      `qualification test ${value.id} requiredDimensions`,
    ),
  };
}

export function validateQualificationContract(value: unknown): QualificationContract {
  if (!isRecord(value)) fail("qualification contract is not an object");
  assertExactKeys(value, CONTRACT_KEYS, "qualification contract");
  if (value.schemaVersion !== QUALIFICATION_CONTRACT_SCHEMA_VERSION) {
    fail("qualification contract schemaVersion is unsupported");
  }
  if (value.scope !== QUALIFICATION_SCOPE) fail("qualification contract scope is unsupported");
  const repository = validateRepository(value.repository);
  const inventoryState = validateInventoryState(value.inventoryState);
  const lifecycle = validateLifecycle(value.lifecycle);
  const requiredWorkflowGate =
    value.requiredWorkflowGate === null
      ? null
      : validateRequiredWorkflowGate(value.requiredWorkflowGate);
  if (inventoryState === "frozen" && requiredWorkflowGate === null) {
    fail("qualification frozen inventory requires organization required-workflow authority");
  }
  const retirementEvidence =
    value.retirementEvidence === null
      ? null
      : validateQualificationRetirementEvidence(value.retirementEvidence);
  if (lifecycle === "retired" && retirementEvidence === null) {
    fail("qualification retired lifecycle requires authenticated retirement evidence");
  }
  if (lifecycle !== "retired" && retirementEvidence !== null) {
    fail("qualification retirement evidence is valid only in retired lifecycle");
  }
  if (!positiveInteger(value.requiredStatusRulesetId)) {
    fail("qualification requiredStatusRulesetId is invalid");
  }
  const artifacts = validateArtifacts(value.artifacts);
  const trustedProducerWorkflowPath = validateWorkflowPath(value.trustedProducerWorkflowPath);
  if (!Array.isArray(value.tests) || value.tests.length === 0 || value.tests.length > MAX_TESTS) {
    fail("qualification contract tests must be a nonempty bounded array");
  }
  const tests = value.tests.map(validateTestDescriptor);
  const ids = tests.map((test) => test.id);
  if (new Set(ids).size !== ids.length) fail("qualification contract test IDs are duplicated");
  if (!tests.some((test) => test.phases.includes("final"))) {
    fail("qualification contract has no final tests");
  }
  if (lifecycle !== "bootstrap" && inventoryState !== "frozen") {
    fail(`qualification ${lifecycle} lifecycle requires a frozen inventory`);
  }
  if (
    inventoryState === "draft" &&
    tests.some((test) =>
      Object.values(test.mappings).some((mapping) => mapping?.status !== "pending"),
    )
  ) {
    fail("qualification draft inventory cannot activate a source mapping");
  }
  if (inventoryState === "frozen") {
    requireCompleteArtifacts(artifacts);
    let aggregateCellBytes = 0;
    let aggregateCells = 0;
    for (const test of tests) {
      requireCompleteQualificationMatrix(test.matrix, test.id);
      let hasTargetPass = false;
      let hasKeepaliveKnownFailureControl = false;
      const behaviors = [...new Set(test.matrix.lanes.flatMap((lane) => lane.behaviors))].sort();
      const requiredCases = [...test.requiredCases].sort();
      if (
        behaviors.length !== requiredCases.length ||
        behaviors.some((behavior, index) => behavior !== requiredCases[index])
      ) {
        fail(`qualification test ${test.id} frozen matrix behaviors do not match requiredCases`);
      }
      const artifactComponents = new Set(artifacts.map((artifact) => artifact.component));
      for (const lane of test.matrix.lanes) {
        for (const component of lane.artifactComponents) {
          if (!artifactComponents.has(component)) {
            fail(
              `qualification test ${test.id} matrix lane ${lane.id} uses unknown artifact ${component}`,
            );
          }
        }
        for (const runtimeVersion of lane.runtimeVersions) {
          const target =
            runtimeVersion.version === QUALIFICATION_TARGET_VERSION &&
            runtimeVersion.commitSha === QUALIFICATION_TARGET_COMMIT_SHA &&
            lane.expectedOutcome === "pass";
          const knownFailureControl =
            test.id === "openshell-00101-keepalive" &&
            runtimeVersion.version === QUALIFICATION_REPOSITORY_BASELINE_VERSION &&
            runtimeVersion.commitSha === QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA &&
            lane.expectedOutcome === "known-failure";
          hasTargetPass ||= target;
          hasKeepaliveKnownFailureControl ||= knownFailureControl;
          if (!target && !knownFailureControl) {
            fail(`qualification test ${test.id} has an unapproved runtime matrix identity`);
          }
        }
      }
      if (!hasTargetPass) {
        fail(`qualification test ${test.id} has no target-pass runtime matrix lane`);
      }
      if (test.id === "openshell-00101-keepalive" && !hasKeepaliveKnownFailureControl) {
        fail("qualification keepalive test has no repository-baseline known-failure control lane");
      }
      const footprint = qualificationCellInventoryFootprint(
        test.matrix,
        test.approvedExceptions,
        repository,
        test.id,
      );
      aggregateCells += footprint.cells;
      aggregateCellBytes += footprint.bytes;
      if (
        aggregateCells > QUALIFICATION_MAX_AGGREGATE_MATRIX_CELLS ||
        aggregateCellBytes > QUALIFICATION_MAX_AGGREGATE_CELL_BYTES
      ) {
        fail("qualification frozen inventory exceeds the aggregate receipt cell budget");
      }
      for (const phase of test.phases) {
        const mapping = test.mappings[phase];
        if (!mapping || mapping.source === null) {
          fail(`qualification frozen inventory has no staged ${phase} source for ${test.id}`);
        }
      }
    }
  }
  if (lifecycle === "selector") requireActiveQualificationTestsFromTests(tests, "selector");
  if (lifecycle === "final") requireActiveQualificationTestsFromTests(tests, "final");
  return {
    ...validateIdentity(value),
    artifacts,
    inventoryState,
    lifecycle,
    repository,
    requiredWorkflowGate,
    retirementEvidence,
    schemaVersion: QUALIFICATION_CONTRACT_SCHEMA_VERSION,
    scope: QUALIFICATION_SCOPE,
    requiredStatusRulesetId: value.requiredStatusRulesetId,
    tests,
    trustedProducerWorkflowPath,
  };
}

export function validateQualificationLifecycleTransition(
  baseValue: QualificationContract | unknown,
  candidateValue: QualificationContract | unknown,
  versions: { baselineVersion: string; targetVersion: string },
): QualificationContract {
  const base = validateQualificationContract(baseValue);
  const candidate = validateQualificationContract(candidateValue);
  for (const key of IDENTITY_KEYS) {
    if (base[key] !== candidate[key]) {
      fail(`qualification lifecycle transition changed ${key}`);
    }
  }
  const draftStaging =
    base.lifecycle === "bootstrap" &&
    candidate.lifecycle === "bootstrap" &&
    base.inventoryState === "draft" &&
    candidate.inventoryState === "draft";
  const freezing =
    base.lifecycle === "bootstrap" &&
    candidate.lifecycle === "bootstrap" &&
    base.inventoryState === "draft" &&
    candidate.inventoryState === "frozen";
  if (
    base.repository !== candidate.repository ||
    base.scope !== candidate.scope ||
    base.schemaVersion !== candidate.schemaVersion ||
    (!draftStaging &&
      (base.requiredStatusRulesetId !== candidate.requiredStatusRulesetId ||
        JSON.stringify(base.requiredWorkflowGate) !==
          JSON.stringify(candidate.requiredWorkflowGate) ||
        base.trustedProducerWorkflowPath !== candidate.trustedProducerWorkflowPath))
  ) {
    fail("qualification lifecycle transition changed contract authority");
  }
  if (base.inventoryState === "frozen" && candidate.inventoryState !== "frozen") {
    fail("qualification frozen inventory cannot return to draft");
  }
  if (base.inventoryState === "draft" && candidate.inventoryState === "frozen" && !freezing) {
    fail("qualification inventory must freeze in a separate bootstrap state-only transition");
  }
  if (freezing) {
    const { inventoryState: _baseState, ...baseFrozen } = base;
    const { inventoryState: _candidateState, ...candidateFrozen } = candidate;
    if (JSON.stringify(baseFrozen) !== JSON.stringify(candidateFrozen)) {
      fail("qualification draft to frozen transition must be a state-only flip");
    }
  }
  if (draftStaging) {
    if (
      versions.baselineVersion !== base.openshellRepositoryBaselineVersion ||
      versions.targetVersion !== base.openshellRepositoryBaselineVersion
    ) {
      fail("qualification bootstrap lifecycle requires the repository baseline version");
    }
    return candidate;
  }
  if (JSON.stringify(base.artifacts) !== JSON.stringify(candidate.artifacts)) {
    fail("qualification lifecycle transition changed frozen artifact provenance");
  }
  if (candidate.tests.length !== base.tests.length) {
    fail("qualification lifecycle transition changed the required test inventory");
  }
  const order: QualificationLifecycle[] = ["bootstrap", "selector", "final", "retired"];
  const baseIndex = order.indexOf(base.lifecycle);
  const candidateIndex = order.indexOf(candidate.lifecycle);
  if (candidateIndex !== baseIndex && candidateIndex !== baseIndex + 1) {
    fail(
      `qualification lifecycle transition ${base.lifecycle} -> ${candidate.lifecycle} is invalid`,
    );
  }
  const retiring = base.lifecycle === "final" && candidate.lifecycle === "retired";
  if (
    !retiring &&
    JSON.stringify(base.retirementEvidence) !== JSON.stringify(candidate.retirementEvidence)
  ) {
    fail("qualification lifecycle transition changed retirement evidence");
  }
  if (retiring) {
    const {
      lifecycle: _baseLifecycle,
      retirementEvidence: _baseRetirementEvidence,
      ...baseRetirementState
    } = base;
    const {
      lifecycle: _candidateLifecycle,
      retirementEvidence: _candidateRetirementEvidence,
      ...candidateRetirementState
    } = candidate;
    if (JSON.stringify(baseRetirementState) !== JSON.stringify(candidateRetirementState)) {
      fail(
        "qualification final to retired transition must change only lifecycle and retirement evidence",
      );
    }
  }
  for (const [index, baseTest] of base.tests.entries()) {
    const candidateTest = candidate.tests[index];
    if (!candidateTest)
      fail("qualification lifecycle transition changed the required test inventory");
    const { mappings: baseMappings, ...baseDefinition } = baseTest;
    const { mappings: candidateMappings, ...candidateDefinition } = candidateTest;
    if (JSON.stringify(baseDefinition) !== JSON.stringify(candidateDefinition)) {
      fail(`qualification lifecycle transition changed test ${baseTest.id}`);
    }
    for (const phase of ["selector", "final"] as const) {
      const baseMapping = baseMappings[phase];
      const candidateMapping = candidateMappings[phase];
      if (!baseMapping || !candidateMapping) {
        fail(`qualification lifecycle transition omitted test ${baseTest.id} ${phase} mapping`);
      }
      if (base.lifecycle === "bootstrap" && candidate.lifecycle === "bootstrap") {
        if (baseMapping.status !== "pending" || candidateMapping.status !== "pending") {
          fail(
            `qualification bootstrap staging must keep test ${baseTest.id} ${phase} mapping pending`,
          );
        }
        if (
          base.inventoryState === "frozen" &&
          JSON.stringify(baseMapping.source) !== JSON.stringify(candidateMapping.source)
        ) {
          fail(`qualification frozen bootstrap changed test ${baseTest.id} ${phase} source`);
        }
        continue;
      }
      if (base.lifecycle === "bootstrap" && candidate.lifecycle === "selector") {
        if (phase === "selector" && baseTest.phases.includes("selector")) {
          if (
            baseMapping.status !== "pending" ||
            baseMapping.source === null ||
            candidateMapping.status !== "active" ||
            JSON.stringify(candidateMapping.source) !== JSON.stringify(baseMapping.source)
          ) {
            fail(
              `qualification selector promotion changed or omitted base-owned test ${baseTest.id} selector source`,
            );
          }
          continue;
        }
        if (
          candidateMapping.status !== baseMapping.status ||
          JSON.stringify(candidateMapping.source) !== JSON.stringify(baseMapping.source)
        ) {
          fail(`qualification selector promotion changed test ${baseTest.id} ${phase} mapping`);
        }
        continue;
      }
      if (base.lifecycle === "selector" && candidate.lifecycle === "final") {
        if (phase === "final" && baseTest.phases.includes("final")) {
          if (
            baseMapping.status !== "pending" ||
            baseMapping.source === null ||
            candidateMapping.status !== "active" ||
            JSON.stringify(candidateMapping.source) !== JSON.stringify(baseMapping.source)
          ) {
            fail(
              `qualification final promotion changed or omitted base-owned test ${baseTest.id} final source`,
            );
          }
          continue;
        }
        if (
          candidateMapping.status !== baseMapping.status ||
          JSON.stringify(candidateMapping.source) !== JSON.stringify(baseMapping.source)
        ) {
          fail(`qualification final promotion changed test ${baseTest.id} ${phase} mapping`);
        }
        continue;
      }
      if (
        baseMapping.status === "pending" &&
        (candidateMapping.status !== "pending" ||
          JSON.stringify(candidateMapping.source) !== JSON.stringify(baseMapping.source))
      ) {
        fail(
          `qualification lifecycle transition changed frozen pending test ${baseTest.id} ${phase} mapping`,
        );
      }
      if (
        baseMapping.status === "active" &&
        (candidateMapping.status !== "active" ||
          JSON.stringify(candidateMapping.source) !== JSON.stringify(baseMapping.source))
      ) {
        fail(
          `qualification lifecycle transition changed active test ${baseTest.id} ${phase} mapping`,
        );
      }
    }
  }
  if (base.lifecycle === "bootstrap") {
    if (
      versions.baselineVersion !== base.openshellRepositoryBaselineVersion ||
      versions.targetVersion !== base.openshellRepositoryBaselineVersion
    ) {
      fail("qualification bootstrap lifecycle requires the repository baseline version");
    }
  } else if (candidate.lifecycle === "selector") {
    const sameRepositoryBaseline =
      versions.baselineVersion === base.openshellRepositoryBaselineVersion &&
      versions.targetVersion === base.openshellRepositoryBaselineVersion;
    const sameTarget =
      versions.baselineVersion === base.openshellTargetVersion &&
      versions.targetVersion === base.openshellTargetVersion;
    const approvedUpgrade =
      versions.baselineVersion === base.openshellRepositoryBaselineVersion &&
      versions.targetVersion === base.openshellTargetVersion;
    if (!sameRepositoryBaseline && !sameTarget && !approvedUpgrade) {
      fail("qualification version transition must be the approved repository baseline to target");
    }
  } else if (
    (candidate.lifecycle === "final" || candidate.lifecycle === "retired") &&
    (versions.baselineVersion !== base.openshellTargetVersion ||
      versions.targetVersion !== base.openshellTargetVersion)
  ) {
    fail("qualification final or retired lifecycle requires the target version");
  }
  return candidate;
}

export function qualificationReceiptContract(
  baseContract: QualificationContract,
  candidateValue: QualificationContract | unknown,
  phase: QualificationPhase,
  executionContext: QualificationExecutionContext,
): QualificationContract {
  validatePhaseExecutionContext(phase, executionContext);
  if (baseContract.inventoryState !== "frozen") {
    fail("qualification receipts cannot be produced from a draft inventory");
  }
  const candidateContract = validateQualificationContract(candidateValue);
  if (executionContext === "selector" && baseContract.lifecycle === "bootstrap") {
    if (candidateContract.lifecycle !== "selector") {
      fail("bootstrap selector receipt production requires exact selector activation");
    }
    return validateQualificationLifecycleTransition(baseContract, candidateContract, {
      baselineVersion: baseContract.openshellRepositoryBaselineVersion,
      targetVersion: baseContract.openshellRepositoryBaselineVersion,
    });
  }
  if (executionContext === "selector" && baseContract.lifecycle === "selector") {
    validateQualificationLifecycleTransition(baseContract, candidateContract, {
      baselineVersion:
        candidateContract.lifecycle === "final"
          ? baseContract.openshellTargetVersion
          : baseContract.openshellRepositoryBaselineVersion,
      targetVersion:
        candidateContract.lifecycle === "final"
          ? baseContract.openshellTargetVersion
          : baseContract.openshellRepositoryBaselineVersion,
    });
    return baseContract;
  }
  if (
    executionContext === "final-promotion" &&
    (baseContract.lifecycle !== "selector" || candidateContract.lifecycle !== "final")
  ) {
    fail("final-promotion receipts require an exact selector to final lifecycle transition");
  }
  if (executionContext === "final-promotion" || executionContext === "release") {
    const promoted = validateQualificationLifecycleTransition(baseContract, candidateContract, {
      baselineVersion: baseContract.openshellTargetVersion,
      targetVersion: baseContract.openshellTargetVersion,
    });
    if (promoted.lifecycle !== "final") {
      fail(`${executionContext} receipts require final lifecycle`);
    }
    return promoted;
  }
  fail(`selector receipts are not valid in ${baseContract.lifecycle} lifecycle`);
}

export function requiredQualificationTests(
  contract: QualificationContract,
  phase: QualificationPhase,
): QualificationTestDescriptor[] {
  return contract.tests.filter((test) => test.phases.includes(phase));
}

function activeDescriptor(
  descriptor: QualificationTestDescriptor,
  phase: QualificationPhase,
): ActiveQualificationTestDescriptor | undefined {
  const mapping = descriptor.mappings[phase];
  if (!mapping || mapping.status !== "active") return undefined;
  const { mappings: _mappings, ...common } = descriptor;
  return { ...common, source: mapping.source, status: "active" };
}

export function activeQualificationTests(
  contract: QualificationContract,
  phase: QualificationPhase,
): ActiveQualificationTestDescriptor[] {
  return requiredQualificationTests(contract, phase).flatMap((descriptor) => {
    const active = activeDescriptor(descriptor, phase);
    return active ? [active] : [];
  });
}

function requireActiveQualificationTestsFromTests(
  tests: QualificationTestDescriptor[],
  phase: QualificationPhase,
): ActiveQualificationTestDescriptor[] {
  const required = tests.filter((test) => test.phases.includes(phase));
  const active = required.flatMap((descriptor) => {
    const mapped = activeDescriptor(descriptor, phase);
    return mapped ? [mapped] : [];
  });
  if (active.length !== required.length) {
    const activeIds = new Set(active.map((test) => test.id));
    fail(
      `qualification ${phase} gate has pending source mappings: ${required
        .filter((test) => !activeIds.has(test.id))
        .map((test) => test.id)
        .join(", ")}`,
    );
  }
  return active;
}

export function requireActiveQualificationTests(
  contract: QualificationContract,
  phase: QualificationPhase,
): ActiveQualificationTestDescriptor[] {
  return requireActiveQualificationTestsFromTests(contract.tests, phase);
}

export function qualificationTestsForReceipt(
  contract: QualificationContract,
  phase: QualificationPhase,
): ActiveQualificationTestDescriptor[] {
  if (contract.inventoryState !== "frozen") {
    fail("qualification receipts cannot use a draft inventory");
  }
  if (phase === "selector") {
    if (contract.lifecycle === "bootstrap") return activeQualificationTests(contract, phase);
    if (contract.lifecycle === "selector") return requireActiveQualificationTests(contract, phase);
    fail(`qualification selector receipts are not valid in ${contract.lifecycle} lifecycle`);
  }
  if (contract.lifecycle !== "final") {
    fail(`qualification final receipts require final lifecycle, not ${contract.lifecycle}`);
  }
  return requireActiveQualificationTests(contract, phase);
}

export function validateRunUrl(value: unknown, repository: string, label: string): string {
  if (typeof value !== "string" || !SAFE_TEXT_PATTERN.test(value)) fail(`${label} is invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(`/${repository}/`)
  ) {
    fail(`${label} is outside the trusted GitHub repository`);
  }
  const suffix = url.pathname.slice(repository.length + 2);
  if (
    !/^actions\/runs\/[1-9][0-9]*(?:\/(?:attempts\/[1-9][0-9]*|job\/[1-9][0-9]*))?$/u.test(
      suffix,
    ) &&
    !/^runs\/[1-9][0-9]*$/u.test(suffix)
  ) {
    fail(`${label} is not a supported GitHub run link`);
  }
  return value;
}

export function validateResult(value: unknown, label: string): QualificationResult {
  const knownResults = new Set<QualificationResult>([
    "action_required",
    "canceled",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "success",
    "timed_out",
  ]);
  if (typeof value !== "string" || !knownResults.has(value as QualificationResult)) {
    fail(`${label} has an unknown result`);
  }
  return value as QualificationResult;
}

export function validateReceiptJob(
  value: unknown,
  repository: string,
  testId: string,
): QualificationReceiptJob {
  if (!isRecord(value)) fail(`qualification receipt test ${testId} job is not an object`);
  assertExactKeys(value, ["name", "result", "url"], `qualification receipt test ${testId} job`);
  if (typeof value.name !== "string" || !SAFE_TEXT_PATTERN.test(value.name)) {
    fail(`qualification receipt test ${testId} job name is invalid`);
  }
  return {
    name: value.name,
    result: validateResult(value.result, `qualification receipt test ${testId} job ${value.name}`),
    url: validateRunUrl(value.url, repository, `qualification receipt test ${testId} job URL`),
  };
}

function validateReceiptRun(
  value: unknown,
  repository: string,
  descriptor: ActiveQualificationTestDescriptor,
  expected: QualificationReceiptExpectation,
  contract: QualificationContract,
): QualificationReceiptRun {
  if (!isRecord(value)) fail(`qualification receipt test ${descriptor.id} run is not an object`);
  assertExactKeys(
    value,
    [
      "authorityPaths",
      "baseSha",
      "candidateSha",
      "cells",
      "controllerSha",
      "event",
      "executionContext",
      "jobs",
      "openshellCommitSha",
      "openshellVersion",
      "phase",
      "prNumber",
      "requiredCases",
      "requiredDimensions",
      "result",
      "runAttempt",
      "runId",
      "runUrl",
      "workflowId",
      "workflowPath",
    ],
    `qualification receipt test ${descriptor.id} run`,
  );
  if (typeof value.runId !== "string" || !RUN_ID_PATTERN.test(value.runId)) {
    fail(`qualification receipt test ${descriptor.id} run ID is invalid`);
  }
  if (!positiveInteger(value.runAttempt)) {
    fail(`qualification receipt test ${descriptor.id} run attempt is invalid`);
  }
  const runUrl = validateRunUrl(
    value.runUrl,
    repository,
    `qualification receipt test ${descriptor.id} run URL`,
  );
  if (
    runUrl !==
    `https://github.com/${repository}/actions/runs/${value.runId}/attempts/${value.runAttempt}`
  ) {
    fail(`qualification receipt test ${descriptor.id} run metadata is mismatched`);
  }
  const workflowPath = validateWorkflowPath(value.workflowPath);
  const controllerSha = validateSha(
    value.controllerSha,
    `qualification receipt test ${descriptor.id} controller SHA`,
  );
  const baseSha = validateSha(
    value.baseSha,
    `qualification receipt test ${descriptor.id} base SHA`,
  );
  const candidateSha = validateSha(
    value.candidateSha,
    `qualification receipt test ${descriptor.id} candidate SHA`,
  );
  const phase = validatePhase(value.phase);
  const executionContext = validateExecutionContext(value.executionContext);
  const event = validateSourceEvent(value.event);
  const expectedPrNumber = expected.executionContext === "release" ? null : expected.prNumber;
  const expectedControllerSha =
    expected.executionContext === "release" ? expected.candidateSha : expected.baseSha;
  if (
    workflowPath !== descriptor.source.workflowPath ||
    value.workflowId !== descriptor.source.workflowId ||
    event !== descriptor.source.event ||
    controllerSha !== expectedControllerSha ||
    baseSha !== expected.baseSha ||
    candidateSha !== expected.candidateSha ||
    phase !== expected.phase ||
    executionContext !== expected.executionContext ||
    value.prNumber !== expectedPrNumber
  ) {
    fail(`qualification receipt test ${descriptor.id} source workflow identity is mismatched`);
  }
  const prNumber = expectedPrNumber ?? null;
  const authorityPaths = validateStringArray(
    value.authorityPaths,
    `qualification receipt test ${descriptor.id} authorityPaths`,
    validateRepositoryPath,
  );
  const requiredCases = validateTokenArray(
    value.requiredCases,
    `qualification receipt test ${descriptor.id} requiredCases`,
  );
  const requiredDimensions = validateTokenArray(
    value.requiredDimensions,
    `qualification receipt test ${descriptor.id} requiredDimensions`,
  );
  if (
    JSON.stringify(authorityPaths) !== JSON.stringify(descriptor.source.authorityPaths) ||
    JSON.stringify(requiredCases) !== JSON.stringify(descriptor.requiredCases) ||
    JSON.stringify(requiredDimensions) !== JSON.stringify(descriptor.requiredDimensions) ||
    value.openshellVersion !== contract.openshellTargetVersion ||
    value.openshellCommitSha !== contract.openshellTargetCommitSha
  ) {
    fail(`qualification receipt test ${descriptor.id} semantic evidence is mismatched`);
  }
  if (!Array.isArray(value.jobs) || value.jobs.length === 0 || value.jobs.length > MAX_TESTS) {
    fail(`qualification receipt test ${descriptor.id} jobs are missing or oversized`);
  }
  const jobs = value.jobs.map((job) => validateReceiptJob(job, repository, descriptor.id));
  const unsuccessfulJob = jobs.find((job) => job.result !== "success");
  if (unsuccessfulJob) {
    fail(
      `qualification receipt test ${descriptor.id} job ${unsuccessfulJob.name} is not successful: ${unsuccessfulJob.result}`,
    );
  }
  const result = validateResult(
    value.result,
    `qualification receipt test ${descriptor.id} run ${value.runId}`,
  );
  if (result !== "success") {
    fail(
      `qualification receipt test ${descriptor.id} run ${value.runId} is not successful: ${result}`,
    );
  }
  const cells = validateQualificationCellResults(
    value.cells,
    descriptor.matrix,
    descriptor.approvedExceptions,
    repository,
    descriptor.id,
    new Set(jobs.map((job) => job.url)),
  );
  return {
    authorityPaths,
    baseSha,
    candidateSha,
    cells,
    controllerSha,
    event,
    executionContext,
    jobs,
    openshellCommitSha: value.openshellCommitSha,
    openshellVersion: value.openshellVersion,
    phase,
    prNumber,
    requiredCases,
    requiredDimensions,
    result,
    runAttempt: value.runAttempt,
    runId: value.runId,
    runUrl,
    workflowId: value.workflowId,
    workflowPath,
  };
}

function validateReceiptTest(
  value: unknown,
  repository: string,
  descriptor: ActiveQualificationTestDescriptor,
  expected: QualificationReceiptExpectation,
  contract: QualificationContract,
): QualificationReceiptTest {
  if (!isRecord(value)) fail("qualification receipt test is not an object");
  assertExactKeys(value, ["id", "result", "runs"], "qualification receipt test");
  if (typeof value.id !== "string" || !TEST_ID_PATTERN.test(value.id)) {
    fail("qualification receipt test id is invalid");
  }
  if (value.id !== descriptor.id) {
    fail(`qualification receipt test ${value.id} has a mismatched source descriptor`);
  }
  if (!Array.isArray(value.runs) || value.runs.length !== 1) {
    fail(`qualification receipt test ${value.id} must contain one source run`);
  }
  const runs = value.runs.map((run) =>
    validateReceiptRun(run, repository, descriptor, expected, contract),
  );
  const actualJobNames = runs.flatMap((run) => run.jobs.map((job) => job.name));
  if (new Set(actualJobNames).size !== actualJobNames.length) {
    fail(`qualification receipt test ${value.id} source jobs are ambiguous or duplicated`);
  }
  const expectedJobNames = descriptor.source.jobNames;
  const actualSorted = [...actualJobNames].sort();
  const expectedSorted = [...expectedJobNames].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((name, index) => name !== expectedSorted[index])
  ) {
    fail(`qualification receipt test ${value.id} source jobs are missing, extra, or mismatched`);
  }
  const result = validateResult(value.result, `qualification receipt test ${value.id}`);
  if (result !== "success") {
    fail(`qualification receipt test ${value.id} is not successful: ${result}`);
  }
  return {
    id: value.id,
    result,
    runs,
  };
}

function assertIdentityMatches(
  receipt: QualificationIdentity,
  contract: QualificationIdentity,
): void {
  for (const key of IDENTITY_KEYS) {
    if (receipt[key] !== contract[key]) fail(`qualification receipt ${key} is mismatched`);
  }
}

export function validateQualificationReceipt(
  value: unknown,
  contractValue: QualificationContract | unknown,
  expected: QualificationReceiptExpectation,
): QualificationReceipt {
  const contract = validateQualificationContract(contractValue);
  if (!isRecord(value)) fail("qualification receipt is not an object");
  assertExactKeys(value, RECEIPT_KEYS, "qualification receipt");
  if (value.schemaVersion !== QUALIFICATION_CONTRACT_SCHEMA_VERSION) {
    fail("qualification receipt schemaVersion is unsupported");
  }
  if (value.scope !== QUALIFICATION_SCOPE) fail("qualification receipt scope is unsupported");
  const repository = validateRepository(value.repository);
  const artifacts = validateArtifacts(value.artifacts);
  if (JSON.stringify(artifacts) !== JSON.stringify(contract.artifacts)) {
    fail("qualification receipt artifact provenance is mismatched");
  }
  const phase = validatePhase(value.phase);
  const executionContext = validateExecutionContext(value.executionContext);
  const lifecycle = validateLifecycle(value.lifecycle);
  validatePhaseExecutionContext(phase, executionContext);
  const candidateSha = validateSha(value.candidateSha, "qualification receipt candidate SHA");
  const baseSha = validateSha(value.baseSha, "qualification receipt base SHA");
  if (
    repository !== contract.repository ||
    repository !== expected.repository ||
    phase !== expected.phase ||
    executionContext !== expected.executionContext ||
    lifecycle !== contract.lifecycle ||
    candidateSha !== expected.candidateSha ||
    baseSha !== expected.baseSha
  ) {
    fail("qualification receipt phase, repository, candidate, or base is stale or mismatched");
  }
  validateSha(expected.candidateSha, "expected candidate SHA");
  validateSha(expected.baseSha, "expected base SHA");
  validateRepository(expected.repository);
  if (candidateSha === baseSha) fail("qualification receipt candidate and base SHAs are identical");
  const expectsPullRequest = executionContext !== "release";
  if (
    (expectsPullRequest &&
      (!positiveInteger(expected.prNumber) || value.prNumber !== expected.prNumber)) ||
    (!expectsPullRequest && (expected.prNumber !== undefined || value.prNumber !== null))
  ) {
    fail("qualification receipt pull-request identity is mismatched");
  }
  const prNumber = expectsPullRequest ? (expected.prNumber as number) : null;

  const trustedProducerWorkflowPath = validateWorkflowPath(value.trustedProducerWorkflowPath);
  const trustedProducerWorkflowSha = validateSha(
    value.trustedProducerWorkflowSha,
    "trusted producer workflow SHA",
  );
  if (
    trustedProducerWorkflowPath !== contract.trustedProducerWorkflowPath ||
    trustedProducerWorkflowSha !== (executionContext === "release" ? candidateSha : baseSha)
  ) {
    fail("qualification receipt trusted producer workflow identity is mismatched");
  }
  if (
    typeof value.trustedProducerRunId !== "string" ||
    !RUN_ID_PATTERN.test(value.trustedProducerRunId)
  ) {
    fail("qualification receipt trusted producer run ID is invalid");
  }
  if (!positiveInteger(value.trustedProducerRunAttempt)) {
    fail("qualification receipt trusted producer run attempt is invalid");
  }
  const trustedProducerRunUrl = validateRunUrl(
    value.trustedProducerRunUrl,
    repository,
    "trusted producer run URL",
  );
  const expectedProducerUrl = `https://github.com/${repository}/actions/runs/${value.trustedProducerRunId}/attempts/${value.trustedProducerRunAttempt}`;
  if (trustedProducerRunUrl !== expectedProducerUrl) {
    fail("qualification receipt trusted producer run metadata is mismatched");
  }

  if (!Array.isArray(value.tests) || value.tests.length > MAX_TESTS) {
    fail("qualification receipt tests are malformed or oversized");
  }
  const activeDescriptors = qualificationTestsForReceipt(contract, phase);
  const descriptorsById = new Map(
    activeDescriptors.map((descriptor) => [descriptor.id, descriptor]),
  );
  const tests = value.tests.map((test) => {
    if (!isRecord(test) || typeof test.id !== "string") {
      fail("qualification receipt test is malformed");
    }
    const descriptor = descriptorsById.get(test.id);
    if (!descriptor) fail(`qualification receipt test ${test.id} has no active source mapping`);
    return validateReceiptTest(test, repository, descriptor, expected, contract);
  });
  const actualIds = tests.map((test) => test.id);
  if (new Set(actualIds).size !== actualIds.length) {
    fail("qualification receipt test IDs are duplicated");
  }
  const requiredIds = activeDescriptors.map((test) => test.id);
  const actualSorted = [...actualIds].sort();
  const requiredSorted = [...requiredIds].sort();
  if (
    actualSorted.length !== requiredSorted.length ||
    actualSorted.some((id, index) => id !== requiredSorted[index])
  ) {
    fail("qualification receipt required test set is missing, extra, or mismatched");
  }
  const identity = validateIdentity(value);
  assertIdentityMatches(identity, contract);
  return {
    ...identity,
    artifacts,
    baseSha,
    candidateSha,
    executionContext,
    lifecycle,
    phase,
    prNumber,
    repository,
    schemaVersion: QUALIFICATION_CONTRACT_SCHEMA_VERSION,
    scope: QUALIFICATION_SCOPE,
    tests,
    trustedProducerRunAttempt: value.trustedProducerRunAttempt,
    trustedProducerRunId: value.trustedProducerRunId,
    trustedProducerRunUrl,
    trustedProducerWorkflowPath,
    trustedProducerWorkflowSha,
  };
}

export function createQualificationReceipt(
  contractValue: QualificationContract | unknown,
  input: CreateQualificationReceiptInput,
): QualificationReceipt {
  const contract = validateQualificationContract(contractValue);
  const candidate: QualificationReceipt = {
    ...Object.fromEntries(IDENTITY_KEYS.map((key) => [key, contract[key]])),
    artifacts: contract.artifacts,
    baseSha: input.baseSha,
    candidateSha: input.candidateSha,
    executionContext: input.executionContext,
    lifecycle: contract.lifecycle,
    phase: input.phase,
    prNumber: input.executionContext === "release" ? null : (input.prNumber ?? null),
    repository: input.repository,
    schemaVersion: QUALIFICATION_CONTRACT_SCHEMA_VERSION,
    scope: QUALIFICATION_SCOPE,
    tests: input.tests,
    trustedProducerRunAttempt: input.trustedProducerRunAttempt,
    trustedProducerRunId: input.trustedProducerRunId,
    trustedProducerRunUrl: input.trustedProducerRunUrl,
    trustedProducerWorkflowPath: contract.trustedProducerWorkflowPath,
    trustedProducerWorkflowSha: input.trustedProducerWorkflowSha,
  } as QualificationReceipt;
  return validateQualificationReceipt(candidate, contract, input);
}
