// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

export const QUALIFICATION_CONTRACT_PATH = "ci/openshell-0.0.101-qualification-v1.json" as const;
export const QUALIFICATION_REQUIRED_WORKFLOW_PATH =
  ".github/workflows/openshell-0.0.101-pr-gate.yaml" as const;
export const QUALIFICATION_REQUIRED_WORKFLOW_REF = "refs/heads/main" as const;
export const QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID = 1182547092 as const;
export const QUALIFICATION_MAX_JSON_BYTES = 2 * 1024 * 1024;

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const TOP_LEVEL_KEYS = [
  "artifacts",
  "inventoryState",
  "lifecycle",
  "nemoclawRepositoryBaselineSha",
  "nemoclawUserBaselineCommitSha",
  "nemoclawUserBaselineTag",
  "nemoclawUserBaselineTagObjectSha",
  "openshellBaselineCommitSha",
  "openshellBaselineTag",
  "openshellBaselineVersion",
  "openshellRepositoryBaselineCommitSha",
  "openshellRepositoryBaselineTag",
  "openshellRepositoryBaselineVersion",
  "openshellTargetCommitSha",
  "openshellTargetTag",
  "openshellTargetVersion",
  "repository",
  "requiredStatusRulesetId",
  "requiredWorkflowGate",
  "retirementEvidence",
  "schemaVersion",
  "scope",
  "tests",
  "trustedProducerWorkflowPath",
] as const;
const TEST_KEYS = [
  "approvedExceptions",
  "id",
  "mappings",
  "matrix",
  "ownerIssues",
  "phases",
  "requiredCases",
  "requiredDimensions",
] as const;
const FIXED_FIELDS = {
  schemaVersion: 1,
  scope: "NVIDIA/NemoClaw#8590",
  repository: "NVIDIA/NemoClaw",
  inventoryState: "draft",
  retirementEvidence: null,
  requiredStatusRulesetId: 15735613,
  artifacts: [],
  nemoclawRepositoryBaselineSha: "02398f3433f8c8d4cc329328229854bde7f4ce77",
  nemoclawUserBaselineTag: "v0.0.104",
  nemoclawUserBaselineTagObjectSha: "fc9b7ecee4e81048ab0f2c73c513cd606313797a",
  nemoclawUserBaselineCommitSha: "f389c9d872775006ae069473f58250fa8f3ad40f",
  lifecycle: "bootstrap",
  openshellRepositoryBaselineVersion: "0.0.99",
  openshellRepositoryBaselineTag: "v0.0.99",
  openshellRepositoryBaselineCommitSha: "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032",
  openshellBaselineVersion: "0.0.85",
  openshellBaselineTag: "v0.0.85",
  openshellBaselineCommitSha: "3dee5570a46076a57a3b056f35f35ebc0861ac85",
  openshellTargetVersion: "0.0.101",
  openshellTargetTag: "v0.0.101",
  openshellTargetCommitSha: "8ddd98c3dff62619a3963f99ba1e055b67650e72",
  trustedProducerWorkflowPath: ".github/workflows/openshell-0.0.101-qualification.yaml",
} as const;

export type QualificationRequiredWorkflowGate = {
  organizationRulesetId: number;
  repositoryId: typeof QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID;
  sourcePath: typeof QUALIFICATION_REQUIRED_WORKFLOW_PATH;
  sourceRef: typeof QUALIFICATION_REQUIRED_WORKFLOW_REF;
};

type PendingMapping = { source: null; status: "pending" };

export type BootstrapQualificationTest = {
  approvedExceptions: [];
  id: string;
  mappings: { final: PendingMapping; selector: PendingMapping };
  matrix: { lanes: [] };
  ownerIssues: number[];
  phases: ["selector"] | ["selector", "final"];
  requiredCases: string[];
  requiredDimensions: string[];
};

export type BootstrapQualificationContract = typeof FIXED_FIELDS & {
  requiredWorkflowGate: QualificationRequiredWorkflowGate | null;
  tests: BootstrapQualificationTest[];
};

export function failQualificationGate(message: string): never {
  throw new Error(`OpenShell qualification PR gate failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    failQualificationGate(`${label} fields are invalid`);
  }
}

function assertEmptyArray(value: unknown, label: string): asserts value is [] {
  if (!Array.isArray(value) || value.length !== 0) {
    failQualificationGate(`${label} must remain empty in draft`);
  }
}

function validateUniqueTokens(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    failQualificationGate(`${label} must be a bounded nonempty list`);
  }
  const tokens = value.map((entry) => {
    if (typeof entry !== "string" || !TOKEN_PATTERN.test(entry)) {
      failQualificationGate(`${label} contains an invalid identifier`);
    }
    return entry;
  });
  if (new Set(tokens).size !== tokens.length) {
    failQualificationGate(`${label} contains a duplicate identifier`);
  }
  return tokens;
}

function validatePendingMapping(value: unknown, label: string): PendingMapping {
  if (!isRecord(value)) failQualificationGate(`${label} is not an object`);
  assertExactKeys(value, ["source", "status"], label);
  if (value.status !== "pending" || value.source !== null) {
    failQualificationGate(`${label} must remain pending without a source`);
  }
  return { source: null, status: "pending" };
}

function validateTest(value: unknown): BootstrapQualificationTest {
  if (!isRecord(value)) failQualificationGate("qualification test is not an object");
  assertExactKeys(value, TEST_KEYS, "qualification test");
  if (typeof value.id !== "string" || !TOKEN_PATTERN.test(value.id)) {
    failQualificationGate("qualification test id is invalid");
  }
  assertEmptyArray(value.approvedExceptions, `qualification test ${value.id} exceptions`);
  if (!isRecord(value.matrix)) {
    failQualificationGate(`qualification test ${value.id} matrix is not an object`);
  }
  assertExactKeys(value.matrix, ["lanes"], `qualification test ${value.id} matrix`);
  assertEmptyArray(value.matrix.lanes, `qualification test ${value.id} matrix lanes`);
  if (!Array.isArray(value.ownerIssues) || value.ownerIssues.length === 0) {
    failQualificationGate(`qualification test ${value.id} owner issues are invalid`);
  }
  const ownerIssues = value.ownerIssues.map((entry) => {
    if (!Number.isSafeInteger(entry) || (entry as number) <= 0) {
      failQualificationGate(`qualification test ${value.id} owner issue is invalid`);
    }
    return entry as number;
  });
  if (new Set(ownerIssues).size !== ownerIssues.length) {
    failQualificationGate(`qualification test ${value.id} owner issues contain a duplicate`);
  }
  if (
    !Array.isArray(value.phases) ||
    (value.phases.length !== 1 && value.phases.length !== 2) ||
    value.phases[0] !== "selector" ||
    (value.phases.length === 2 && value.phases[1] !== "final")
  ) {
    failQualificationGate(`qualification test ${value.id} phases are invalid`);
  }
  if (!isRecord(value.mappings)) {
    failQualificationGate(`qualification test ${value.id} mappings are not an object`);
  }
  assertExactKeys(value.mappings, ["final", "selector"], `qualification test ${value.id} mappings`);
  const mappings = {
    final: validatePendingMapping(
      value.mappings.final,
      `qualification test ${value.id} final mapping`,
    ),
    selector: validatePendingMapping(
      value.mappings.selector,
      `qualification test ${value.id} selector mapping`,
    ),
  };
  return {
    approvedExceptions: [],
    id: value.id,
    mappings,
    matrix: { lanes: [] },
    ownerIssues,
    phases: value.phases as ["selector"] | ["selector", "final"],
    requiredCases: validateUniqueTokens(
      value.requiredCases,
      `qualification test ${value.id} required cases`,
    ),
    requiredDimensions: validateUniqueTokens(
      value.requiredDimensions,
      `qualification test ${value.id} required dimensions`,
    ),
  };
}

function validateRequiredWorkflowGate(value: unknown): QualificationRequiredWorkflowGate | null {
  if (value === null) return null;
  if (!isRecord(value)) failQualificationGate("required workflow gate is not an object");
  assertExactKeys(
    value,
    ["organizationRulesetId", "repositoryId", "sourcePath", "sourceRef"],
    "required workflow gate",
  );
  if (
    !Number.isSafeInteger(value.organizationRulesetId) ||
    (value.organizationRulesetId as number) <= 0 ||
    value.repositoryId !== QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID ||
    value.sourcePath !== QUALIFICATION_REQUIRED_WORKFLOW_PATH ||
    value.sourceRef !== QUALIFICATION_REQUIRED_WORKFLOW_REF
  ) {
    failQualificationGate("required workflow gate authority is invalid");
  }
  return {
    organizationRulesetId: value.organizationRulesetId as number,
    repositoryId: QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID,
    sourcePath: QUALIFICATION_REQUIRED_WORKFLOW_PATH,
    sourceRef: QUALIFICATION_REQUIRED_WORKFLOW_REF,
  };
}

export function validateBootstrapQualificationContract(
  value: unknown,
): BootstrapQualificationContract {
  if (!isRecord(value)) failQualificationGate("qualification contract is not an object");
  assertExactKeys(value, TOP_LEVEL_KEYS, "qualification contract");
  for (const [key, expected] of Object.entries(FIXED_FIELDS)) {
    if (!isDeepStrictEqual(value[key], expected)) {
      failQualificationGate(`qualification contract ${key} is invalid for draft bootstrap`);
    }
  }
  if (!Array.isArray(value.tests) || value.tests.length === 0 || value.tests.length > 128) {
    failQualificationGate("qualification tests must be a bounded nonempty list");
  }
  const tests = value.tests.map(validateTest);
  if (new Set(tests.map((test) => test.id)).size !== tests.length) {
    failQualificationGate("qualification test ids contain a duplicate");
  }
  return {
    ...FIXED_FIELDS,
    requiredWorkflowGate: validateRequiredWorkflowGate(value.requiredWorkflowGate),
    tests,
  };
}

export function validateBootstrapDraftTransition(
  baseValue: unknown | null,
  candidateValue: unknown | null,
  versions: { baseVersion: string; candidateVersion: string },
): BootstrapQualificationContract {
  if (baseValue === null && candidateValue !== null) {
    failQualificationGate(
      "candidate contract cannot establish authority absent from the trusted base",
    );
  }
  if (baseValue === null || candidateValue === null) {
    failQualificationGate("draft bootstrap contract cannot be removed");
  }
  if (versions.baseVersion !== "0.0.99" || versions.candidateVersion !== "0.0.99") {
    failQualificationGate("draft bootstrap cannot change the pinned OpenShell version");
  }
  const base = validateBootstrapQualificationContract(baseValue);
  const candidate = validateBootstrapQualificationContract(candidateValue);
  const comparableBase = { ...base, requiredWorkflowGate: null };
  const comparableCandidate = { ...candidate, requiredWorkflowGate: null };
  if (!isDeepStrictEqual(comparableBase, comparableCandidate)) {
    failQualificationGate("draft bootstrap contract may change only required workflow authority");
  }
  if (
    base.requiredWorkflowGate !== null &&
    !isDeepStrictEqual(base.requiredWorkflowGate, candidate.requiredWorkflowGate)
  ) {
    failQualificationGate("established required workflow authority cannot change");
  }
  return candidate;
}
