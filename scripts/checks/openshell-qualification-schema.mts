// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  QualificationApprovedException,
  QualificationCellResult,
  QualificationMatrix,
} from "./openshell-qualification-matrix.mts";

export const QUALIFICATION_CONTRACT_SCHEMA_VERSION = 1 as const;
export const QUALIFICATION_SCOPE = "NVIDIA/NemoClaw#8590" as const;
export const QUALIFICATION_CONTRACT_PATH = "ci/openshell-0.0.101-qualification-v1.json" as const;
export const QUALIFICATION_RECEIPT_FILE = "qualification.json" as const;
export const QUALIFICATION_SOURCE_RECEIPT_FILE = "qualification-source.json" as const;
export const QUALIFICATION_RETIREMENT_TAG_MESSAGE_PREFIX =
  "NemoClaw-Qualification-Retirement-Evidence: " as const;
export const QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID = 1182547092 as const;
export const QUALIFICATION_REQUIRED_WORKFLOW_PATH =
  ".github/workflows/openshell-0.0.101-pr-gate.yaml" as const;
export const QUALIFICATION_REQUIRED_WORKFLOW_REF = "refs/heads/main" as const;
export const QUALIFICATION_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const QUALIFICATION_MAX_JSON_BYTES = 2 * 1024 * 1024;
export const QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA =
  "02398f3433f8c8d4cc329328229854bde7f4ce77" as const;
export const QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG = "v0.0.104" as const;
export const QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA =
  "fc9b7ecee4e81048ab0f2c73c513cd606313797a" as const;
export const QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA =
  "f389c9d872775006ae069473f58250fa8f3ad40f" as const;
export const QUALIFICATION_REPOSITORY_BASELINE_VERSION = "0.0.99" as const;
export const QUALIFICATION_REPOSITORY_BASELINE_TAG = "v0.0.99" as const;
export const QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA =
  "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032" as const;
export const QUALIFICATION_PUBLIC_USER_BASELINE_VERSION = "0.0.85" as const;
export const QUALIFICATION_PUBLIC_USER_BASELINE_TAG = "v0.0.85" as const;
export const QUALIFICATION_PUBLIC_USER_BASELINE_COMMIT_SHA =
  "3dee5570a46076a57a3b056f35f35ebc0861ac85" as const;
export const QUALIFICATION_TARGET_VERSION = "0.0.101" as const;
export const QUALIFICATION_TARGET_TAG = "v0.0.101" as const;
export const QUALIFICATION_TARGET_COMMIT_SHA = "8ddd98c3dff62619a3963f99ba1e055b67650e72" as const;

export type QualificationPhase = "final" | "selector";
export type QualificationExecutionContext = "final-promotion" | "release" | "selector";
export type QualificationLifecycle = "bootstrap" | "final" | "retired" | "selector";
export type QualificationInventoryState = "draft" | "frozen";
export type QualificationSourceEvent = "pull_request" | "push" | "workflow_dispatch";
export type QualificationResult =
  | "action_required"
  | "canceled"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out";

export type QualificationSource = {
  aggregation: "all";
  authorityPaths: string[];
  event: QualificationSourceEvent;
  jobNames: string[];
  workflowId: number;
  workflowPath: string;
};

export type QualificationPhaseMapping =
  | { source: QualificationSource | null; status: "pending" }
  | { source: QualificationSource; status: "active" };

type QualificationTestDescriptorCommon = {
  approvedExceptions: QualificationApprovedException[];
  id: string;
  matrix: QualificationMatrix;
  mappings: Partial<Record<QualificationPhase, QualificationPhaseMapping>>;
  ownerIssues: number[];
  phases: QualificationPhase[];
  requiredCases: string[];
  requiredDimensions: string[];
};

export type QualificationTestDescriptor = QualificationTestDescriptorCommon;

export type ActiveQualificationTestDescriptor = Omit<
  QualificationTestDescriptorCommon,
  "mappings"
> & {
  source: QualificationSource;
  status: "active";
};

export type QualificationIdentity = {
  nemoclawRepositoryBaselineSha: string;
  nemoclawUserBaselineCommitSha: string;
  nemoclawUserBaselineTag: string;
  nemoclawUserBaselineTagObjectSha: string;
  openshellRepositoryBaselineCommitSha: string;
  openshellRepositoryBaselineTag: string;
  openshellRepositoryBaselineVersion: string;
  openshellBaselineCommitSha: string;
  openshellBaselineTag: string;
  openshellBaselineVersion: string;
  openshellTargetCommitSha: string;
  openshellTargetTag: string;
  openshellTargetVersion: string;
};

export type QualificationArtifactProvenance = {
  component: string;
  consumers: string[];
  name: string;
  sha256: string;
  url: string;
};

export type QualificationRetirementTagMetadata = {
  finalContractSha256: string;
  finalReceiptSha256: string;
  releaseBaseSha: string;
  releaseCandidateSha: string;
  releaseTag: string;
  schemaVersion: typeof QUALIFICATION_CONTRACT_SCHEMA_VERSION;
  scope: typeof QUALIFICATION_SCOPE;
  trustedProducerRunAttempt: number;
  trustedProducerRunId: string;
  trustedProducerWorkflowSha: string;
};

export type QualificationRetirementEvidence = QualificationRetirementTagMetadata & {
  releaseTagObjectSha: string;
};

export type QualificationRequiredWorkflowGate = {
  organizationRulesetId: number;
  repositoryId: typeof QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID;
  sourcePath: typeof QUALIFICATION_REQUIRED_WORKFLOW_PATH;
  sourceRef: typeof QUALIFICATION_REQUIRED_WORKFLOW_REF;
};

export type QualificationContract = QualificationIdentity & {
  artifacts: QualificationArtifactProvenance[];
  inventoryState: QualificationInventoryState;
  lifecycle: QualificationLifecycle;
  repository: string;
  requiredWorkflowGate: QualificationRequiredWorkflowGate | null;
  retirementEvidence: QualificationRetirementEvidence | null;
  schemaVersion: typeof QUALIFICATION_CONTRACT_SCHEMA_VERSION;
  scope: typeof QUALIFICATION_SCOPE;
  requiredStatusRulesetId: number;
  tests: QualificationTestDescriptor[];
  trustedProducerWorkflowPath: string;
};

export type QualificationReceiptJob = {
  name: string;
  result: QualificationResult;
  url: string;
};

export type QualificationReceiptRun = {
  authorityPaths: string[];
  baseSha: string;
  candidateSha: string;
  cells: QualificationCellResult[];
  controllerSha: string;
  event: QualificationSourceEvent;
  executionContext: QualificationExecutionContext;
  jobs: QualificationReceiptJob[];
  openshellCommitSha: string;
  openshellVersion: string;
  phase: QualificationPhase;
  prNumber: number | null;
  requiredCases: string[];
  requiredDimensions: string[];
  result: QualificationResult;
  runAttempt: number;
  runId: string;
  runUrl: string;
  workflowId: number;
  workflowPath: string;
};

export type QualificationReceiptTest = {
  id: string;
  result: QualificationResult;
  runs: QualificationReceiptRun[];
};

export type QualificationReceipt = QualificationIdentity & {
  artifacts: QualificationArtifactProvenance[];
  baseSha: string;
  candidateSha: string;
  executionContext: QualificationExecutionContext;
  lifecycle: QualificationLifecycle;
  phase: QualificationPhase;
  prNumber: number | null;
  repository: string;
  schemaVersion: typeof QUALIFICATION_CONTRACT_SCHEMA_VERSION;
  scope: typeof QUALIFICATION_SCOPE;
  tests: QualificationReceiptTest[];
  trustedProducerRunAttempt: number;
  trustedProducerRunId: string;
  trustedProducerRunUrl: string;
  trustedProducerWorkflowPath: string;
  trustedProducerWorkflowSha: string;
};

export type QualificationReceiptExpectation = {
  baseSha: string;
  candidateSha: string;
  executionContext: QualificationExecutionContext;
  phase: QualificationPhase;
  prNumber?: number;
  repository: string;
};

export type CreateQualificationReceiptInput = QualificationReceiptExpectation & {
  tests: QualificationReceiptTest[];
  trustedProducerRunAttempt: number;
  trustedProducerRunId: string;
  trustedProducerRunUrl: string;
  trustedProducerWorkflowSha: string;
};

export type QualificationGitHubReader = {
  getBytes(apiPath: string): Promise<Buffer>;
  getJson(apiPath: string): Promise<unknown>;
};

export type QualificationArtifactReader = QualificationGitHubReader;

export type ProduceQualificationReceiptInput = Omit<CreateQualificationReceiptInput, "tests"> & {
  candidateContract?: unknown;
  prNumber?: number;
};
