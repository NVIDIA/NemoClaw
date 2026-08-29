// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { evaluateE2eMaintenancePolicy } from "../../../.agents/skills/nemoclaw-maintainer-fix-e2e-failures/scripts/evaluate-policy.mts";

describe("continuous E2E maintenance write policy", () => {
  it("denies an immediate retry after an ambiguous GitHub write", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "ambiguous-write",
        writeKind: "merge",
        reconciliation: "not-run",
        objectIdentifiersUnchanged: true,
        retryCount: 0,
        transferStarted: false,
      }),
    ).toMatchObject({
      action: "reconcile-read-only",
      allowedWrites: [],
      deniedWrites: ["retry:merge"],
    });
  });

  it("allows one identical retry only after read-only reconciliation", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "ambiguous-write",
        writeKind: "merge",
        reconciliation: "observed-not-applied",
        objectIdentifiersUnchanged: true,
        retryCount: 0,
        transferStarted: false,
      }),
    ).toMatchObject({
      action: "retry-same-write-once",
      allowedWrites: ["retry:merge"],
    });
  });

  it("denies an ambiguous write retry after ownership transfer starts", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "ambiguous-write",
        writeKind: "merge",
        reconciliation: "observed-not-applied",
        objectIdentifiersUnchanged: true,
        retryCount: 0,
        transferStarted: true,
      }),
    ).toMatchObject({
      action: "record-ambiguous-write-blocker",
      allowedWrites: [],
      deniedWrites: ["retry:merge"],
    });
  });

  it("denies fork workflow approval when sensitive workflow code changed", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "fork-workflow-approval",
        ordinaryPullRequestWorkflow: true,
        expectedRepository: true,
        latestPrCommit: true,
        completeDiffReviewed: true,
        sensitiveWorkflowChanged: true,
        exposesPrivilegedCredentials: false,
        authorized: true,
        runState: "action_required",
      }),
    ).toMatchObject({
      allowedWrites: [],
      deniedWrites: ["approve-workflow-run", "dispatch-privileged-e2e"],
    });
  });

  it("allows an ordinary fork workflow after every trust condition passes", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "fork-workflow-approval",
        ordinaryPullRequestWorkflow: true,
        expectedRepository: true,
        latestPrCommit: true,
        completeDiffReviewed: true,
        sensitiveWorkflowChanged: false,
        exposesPrivilegedCredentials: false,
        authorized: true,
        runState: "action_required",
      }),
    ).toMatchObject({
      action: "approve-ordinary-fork-workflow",
      allowedWrites: ["approve-workflow-run"],
      deniedWrites: [],
      queueState: "active",
    });
  });

  it("denies fork workflow approval when the workflow exposes privileged credentials", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "fork-workflow-approval",
        ordinaryPullRequestWorkflow: true,
        expectedRepository: true,
        latestPrCommit: true,
        completeDiffReviewed: true,
        sensitiveWorkflowChanged: false,
        exposesPrivilegedCredentials: true,
        authorized: true,
        runState: "action_required",
      }),
    ).toMatchObject({
      allowedWrites: [],
      deniedWrites: ["approve-workflow-run", "dispatch-privileged-e2e"],
    });
  });

  it("denies self-approval when the review names the latest PR commit", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "review",
        actor: "fix-author",
        opener: "fix-author",
        authors: ["fix-author"],
        latestPrCommitSha: "commit-b",
        reviewedCommitSha: "commit-b",
        checksCommitSha: "commit-b",
        requiredChecksPass: true,
      }),
    ).toMatchObject({
      action: "route-to-independent-reviewer",
      allowedWrites: [],
      deniedWrites: ["submit-approval"],
      queueState: "waiting-review",
    });
  });

  it.each([
    ["opener", " fix-author ", ["primary-author"]],
    ["author", "pr-opener", [" FIX-AUTHOR "]],
    ["co-author", "pr-opener", ["primary-author", " fix-author "]],
  ])("denies approval by a case-varied %s login", (_role, opener, authors) => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "review",
        actor: " Fix-Author ",
        opener,
        authors,
        latestPrCommitSha: "commit-b",
        reviewedCommitSha: "commit-b",
        checksCommitSha: "commit-b",
        requiredChecksPass: true,
      }),
    ).toMatchObject({
      action: "route-to-independent-reviewer",
      allowedWrites: [],
      deniedWrites: ["submit-approval"],
      queueState: "waiting-review",
    });
  });

  it.each([
    ["pending", "commit-b", false],
    ["failing", "commit-b", false],
    ["stale", "commit-a", true],
  ])(
    "denies approval when required checks for the latest PR commit are %s",
    (_state, checksCommitSha, pass) => {
      expect(
        evaluateE2eMaintenancePolicy({
          kind: "review",
          actor: "independent-reviewer",
          opener: "fix-author",
          authors: ["fix-author"],
          latestPrCommitSha: "commit-b",
          reviewedCommitSha: "commit-b",
          checksCommitSha,
          requiredChecksPass: pass,
        }),
      ).toMatchObject({
        action: "wait-for-latest-pr-commit-required-checks",
        allowedWrites: [],
        deniedWrites: ["submit-approval"],
        queueState: "waiting-ci",
      });
    },
  );

  it("allows independent approval after required checks pass for the commit under review", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "review",
        actor: "independent-reviewer",
        opener: "fix-author",
        authors: ["fix-author"],
        latestPrCommitSha: "commit-b",
        reviewedCommitSha: "commit-b",
        checksCommitSha: "commit-b",
        requiredChecksPass: true,
      }),
    ).toMatchObject({
      action: "submit-independent-approval",
      allowedWrites: ["submit-approval"],
      queueState: "approval-ready",
    });
  });

  it("denies a merge when approval and checks belong to an earlier commit", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "merge",
        capturedCommitSha: "commit-a",
        latestPrCommitSha: "commit-b",
        approvedCommitSha: "commit-a",
        checksCommitSha: "commit-a",
        baseMatchesMain: true,
        requiredChecksPass: true,
        independentApproval: true,
        mergeable: true,
        mergeAuthorized: true,
      }),
    ).toMatchObject({
      action: "restart-final-merge-gate",
      allowedWrites: [],
      deniedWrites: ["merge:commit-a"],
    });
  });

  it("allows the merge only when every requirement names the commit under review", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "merge",
        capturedCommitSha: "commit-b",
        latestPrCommitSha: "commit-b",
        approvedCommitSha: "commit-b",
        checksCommitSha: "commit-b",
        baseMatchesMain: true,
        requiredChecksPass: true,
        independentApproval: true,
        mergeable: true,
        mergeAuthorized: true,
      }),
    ).toMatchObject({
      action: "merge-commit-under-review",
      allowedWrites: ["merge:commit-b"],
      deniedWrites: [],
      queueState: "merged",
    });
  });

  it("pauses related merges and permits only an authorized draft revert PR", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "post-merge-e2e",
        originalFailurePresent: true,
        newRegressionPresent: false,
        containmentOwner: "maintainer-a",
        failedMergeSha: "failed-merge",
        rollbackPrAuthorized: true,
        attributionCertain: true,
      }),
    ).toMatchObject({
      action: "open-authorized-draft-revert-pr",
      allowedWrites: ["open-draft-revert-pr:failed-merge"],
      deniedWrites: ["revert-main-directly", "merge-dependent-fix", "merge-revert-without-gates"],
      mergeWritesPaused: true,
      nextActor: "maintainer-a",
      queueState: "blocked",
    });
  });

  it("denies rollback writes when failure attribution is uncertain", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "post-merge-e2e",
        originalFailurePresent: true,
        newRegressionPresent: false,
        containmentOwner: "maintainer-a",
        failedMergeSha: "failed-merge",
        rollbackPrAuthorized: true,
        attributionCertain: false,
      }),
    ).toMatchObject({
      action: "stop-related-merge-writes-and-review-attribution",
      allowedWrites: [],
      deniedWrites: [
        "revert-main-directly",
        "open-draft-revert-pr:failed-merge",
        "merge-dependent-fix",
        "merge-revert-without-gates",
      ],
      mergeWritesPaused: true,
      nextActor: "maintainer reviewing failure attribution",
      queueState: "blocked",
    });
  });

  it("stops all rollback writes when the containment owner lacks authorization", () => {
    expect(
      evaluateE2eMaintenancePolicy({
        kind: "post-merge-e2e",
        originalFailurePresent: false,
        newRegressionPresent: true,
        containmentOwner: "maintainer-a",
        failedMergeSha: "failed-merge",
        rollbackPrAuthorized: false,
        attributionCertain: true,
      }),
    ).toMatchObject({
      action: "stop-related-merge-writes-and-request-rollback-authorization",
      allowedWrites: [],
      mergeWritesPaused: true,
      nextActor: "maintainer with explicit authorization to create a rollback PR",
      queueState: "blocked",
    });
  });
});
