// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createQualificationReceipt,
  QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA,
  QUALIFICATION_PUBLIC_USER_BASELINE_COMMIT_SHA,
  QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA,
  QUALIFICATION_TARGET_COMMIT_SHA,
  type QualificationExecutionContext,
  type QualificationLifecycle,
  type QualificationPhase,
  type QualificationReceipt,
  type QualificationReceiptRun,
} from "../../scripts/checks/openshell-qualification-contract.mts";

export const REPOSITORY = "NVIDIA/NemoClaw";
export const CANDIDATE_SHA = "a".repeat(40);
export const BASE_SHA = "b".repeat(40);
export const PRODUCER_WORKFLOW = ".github/workflows/openshell-0.0.101-qualification.yaml";
export const SOURCE_WORKFLOW = ".github/workflows/source-proof.yaml";
export const SOURCE_CONTROLLER = "scripts/source-proof.mts";
export const SOURCE_WORKFLOW_ID = 77;
export const PR_NUMBER = 8600;

export function retirementEvidence(overrides: Record<string, unknown> = {}) {
  return {
    finalContractSha256: "1".repeat(64),
    finalReceiptSha256: "2".repeat(64),
    releaseBaseSha: BASE_SHA,
    releaseCandidateSha: CANDIDATE_SHA,
    releaseTag: "v0.0.2",
    releaseTagObjectSha: "c".repeat(40),
    schemaVersion: 1,
    scope: "NVIDIA/NemoClaw#8590",
    trustedProducerRunAttempt: 1,
    trustedProducerRunId: "900",
    trustedProducerWorkflowSha: CANDIDATE_SHA,
    ...overrides,
  };
}

export function artifactProvenance() {
  return [
    "checksum-manifest",
    "cli",
    "gateway",
    "package",
    "sandbox-binary",
    "supervisor-image",
    "virtual-machine-driver",
  ].map((component, index) => ({
    component,
    consumers: ["scripts/install-openshell.sh"],
    name: `${component}-${index}`,
    sha256: String(index + 1).repeat(64),
    url: `https://artifacts.example.test/${component}-${index}`,
  }));
}

export function qualificationMatrix() {
  return {
    lanes: [
      {
        agents: ["openclaw"],
        artifactComponents: ["cli"],
        behaviors: ["exact-candidate-base", "real-runtime"],
        expectedOutcome: "pass" as const,
        id: "target",
        paths: ["clean-install"],
        platforms: [
          {
            accelerator: "cpu",
            architecture: "amd64",
            id: "ubuntu-amd64-cpu",
            operatingSystem: "ubuntu",
          },
        ],
        runtimes: ["docker"],
        runtimeVersions: [{ commitSha: QUALIFICATION_TARGET_COMMIT_SHA, version: "0.0.101" }],
      },
    ],
  };
}

export function qualificationCells(runId: number) {
  return ["exact-candidate-base", "real-runtime"].map((behavior) => ({
    agent: "openclaw",
    artifactComponents: ["cli"],
    behavior,
    evidenceUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}/job/501`,
    exception: null,
    laneId: "target",
    observedOutcome: "pass" as const,
    path: "clean-install",
    platformId: "ubuntu-amd64-cpu",
    result: "success" as const,
    runtime: "docker",
    runtimeVersion: "0.0.101",
  }));
}

export function source(phase: QualificationPhase) {
  return {
    aggregation: "all" as const,
    authorityPaths: [SOURCE_WORKFLOW, SOURCE_CONTROLLER],
    event: phase === "selector" ? ("workflow_dispatch" as const) : ("push" as const),
    jobNames: ["Source proof"],
    workflowId: SOURCE_WORKFLOW_ID,
    workflowPath: SOURCE_WORKFLOW,
  };
}

export function descriptor(
  options: {
    final?: "active" | "pending";
    finalPendingSource?: boolean;
    id?: string;
    phases?: QualificationPhase[];
    selector?: "active" | "pending";
    selectorPendingSource?: boolean;
  } = {},
) {
  const selector = options.selector ?? "active";
  const final = options.final ?? "active";
  return {
    approvedExceptions: [],
    id: options.id ?? "shared-proof",
    matrix: qualificationMatrix(),
    mappings: {
      selector:
        selector === "active"
          ? { source: source("selector"), status: "active" as const }
          : {
              source: options.selectorPendingSource ? source("selector") : null,
              status: "pending" as const,
            },
      final:
        final === "active"
          ? { source: source("final"), status: "active" as const }
          : {
              source: options.finalPendingSource ? source("final") : null,
              status: "pending" as const,
            },
    },
    ownerIssues: [8601],
    phases: options.phases ?? (["selector", "final"] as QualificationPhase[]),
    requiredCases: ["exact-candidate-base", "real-runtime"],
    requiredDimensions: ["all-registered-agents", "cpu"],
  };
}

export function contractValue(
  lifecycle: QualificationLifecycle = "selector",
  overrides: Record<string, unknown> = {},
) {
  return {
    artifacts: artifactProvenance(),
    schemaVersion: 1,
    scope: "NVIDIA/NemoClaw#8590",
    repository: REPOSITORY,
    inventoryState: lifecycle === "bootstrap" ? "draft" : "frozen",
    requiredWorkflowGate: {
      organizationRulesetId: 4242,
      repositoryId: 1182547092,
      sourcePath: ".github/workflows/openshell-0.0.101-pr-gate.yaml",
      sourceRef: "refs/heads/main",
    },
    retirementEvidence: lifecycle === "retired" ? retirementEvidence() : null,
    requiredStatusRulesetId: 15735613,
    lifecycle,
    nemoclawRepositoryBaselineSha: QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA,
    nemoclawUserBaselineTag: QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG,
    nemoclawUserBaselineTagObjectSha: QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA,
    nemoclawUserBaselineCommitSha: QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA,
    openshellRepositoryBaselineVersion: "0.0.99",
    openshellRepositoryBaselineTag: "v0.0.99",
    openshellRepositoryBaselineCommitSha: QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA,
    openshellBaselineVersion: "0.0.85",
    openshellBaselineTag: "v0.0.85",
    openshellBaselineCommitSha: QUALIFICATION_PUBLIC_USER_BASELINE_COMMIT_SHA,
    openshellTargetVersion: "0.0.101",
    openshellTargetTag: "v0.0.101",
    openshellTargetCommitSha: QUALIFICATION_TARGET_COMMIT_SHA,
    trustedProducerWorkflowPath: PRODUCER_WORKFLOW,
    tests: [descriptor()],
    ...overrides,
  };
}

export function defaultExecutionContext(phase: QualificationPhase): QualificationExecutionContext {
  return phase === "selector" ? "selector" : "release";
}

export function expectation(
  phase: QualificationPhase = "selector",
  executionContext: QualificationExecutionContext = defaultExecutionContext(phase),
) {
  return {
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    executionContext,
    phase,
    ...(executionContext !== "release" ? { prNumber: PR_NUMBER } : {}),
    repository: REPOSITORY,
  };
}

export function receiptRun(
  phase: QualificationPhase,
  runId = 101,
  executionContext: QualificationExecutionContext = defaultExecutionContext(phase),
): QualificationReceiptRun {
  return {
    authorityPaths: [SOURCE_WORKFLOW, SOURCE_CONTROLLER],
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    cells: qualificationCells(runId),
    controllerSha: executionContext === "release" ? CANDIDATE_SHA : BASE_SHA,
    event: phase === "selector" ? "workflow_dispatch" : "push",
    executionContext,
    jobs: [
      {
        name: "Source proof",
        result: "success",
        url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/job/501`,
      },
    ],
    openshellCommitSha: QUALIFICATION_TARGET_COMMIT_SHA,
    openshellVersion: "0.0.101",
    phase,
    prNumber: executionContext === "release" ? null : PR_NUMBER,
    requiredCases: ["exact-candidate-base", "real-runtime"],
    requiredDimensions: ["all-registered-agents", "cpu"],
    result: "success",
    runAttempt: 1,
    runId: String(runId),
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/1`,
    workflowId: SOURCE_WORKFLOW_ID,
    workflowPath: SOURCE_WORKFLOW,
  };
}

export function receiptInput(
  phase: QualificationPhase,
  executionContext: QualificationExecutionContext = defaultExecutionContext(phase),
) {
  return {
    ...expectation(phase, executionContext),
    tests: [
      {
        id: "shared-proof",
        result: "success" as const,
        runs: [receiptRun(phase, 101, executionContext)],
      },
    ],
    trustedProducerRunAttempt: 1,
    trustedProducerRunId: "900",
    trustedProducerRunUrl: `https://github.com/${REPOSITORY}/actions/runs/900/attempts/1`,
    trustedProducerWorkflowSha: executionContext === "release" ? CANDIDATE_SHA : BASE_SHA,
  };
}

export function validReceipt(
  phase: QualificationPhase = "selector",
  executionContext: QualificationExecutionContext = defaultExecutionContext(phase),
): QualificationReceipt {
  return createQualificationReceipt(
    contractValue(phase === "selector" ? "selector" : "final"),
    receiptInput(phase, executionContext),
  );
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
