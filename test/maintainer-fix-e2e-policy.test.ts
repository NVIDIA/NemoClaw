// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { evaluateFixLoopPolicy } from "../.agents/skills/nemoclaw-maintainer-fix-e2e-failures/scripts/evaluate-policy.mts";

describe("continuous E2E fix-loop executable write policy", () => {
  it("denies an immediate retry after an ambiguous GitHub write", () => {
    expect(
      evaluateFixLoopPolicy({
        kind: "ambiguous-write",
        writeKind: "merge",
        reconciliation: "not-run",
        identitiesUnchanged: true,
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
      evaluateFixLoopPolicy({
        kind: "ambiguous-write",
        writeKind: "merge",
        reconciliation: "observed-not-applied",
        identitiesUnchanged: true,
        retryCount: 0,
        transferStarted: false,
      }),
    ).toMatchObject({
      action: "retry-same-write-once",
      allowedWrites: ["retry:merge"],
    });
  });

  it("denies fork workflow approval when sensitive workflow code changed", () => {
    expect(
      evaluateFixLoopPolicy({
        kind: "fork-workflow-approval",
        ordinaryPullRequestWorkflow: true,
        expectedRepository: true,
        currentHead: true,
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

  it("denies self-approval even when the review names the current head", () => {
    expect(
      evaluateFixLoopPolicy({
        kind: "review",
        actor: "fix-author",
        opener: "fix-author",
        authors: ["fix-author"],
        currentHead: "head-b",
        reviewedHead: "head-b",
      }),
    ).toMatchObject({
      action: "route-to-independent-current-head-reviewer",
      allowedWrites: [],
      deniedWrites: ["submit-approval"],
      queueState: "waiting-review",
    });
  });

  it("denies a merge when approval and checks belong to a stale head", () => {
    expect(
      evaluateFixLoopPolicy({
        kind: "merge",
        capturedHead: "head-a",
        currentHead: "head-b",
        approvedHead: "head-a",
        checksHead: "head-a",
        baseCurrent: true,
        requiredChecksPass: true,
        independentApproval: true,
        mergeable: true,
        mergeAuthorized: true,
      }),
    ).toMatchObject({
      action: "restart-final-merge-gate",
      allowedWrites: [],
      deniedWrites: ["merge:head-a"],
    });
  });

  it("pauses related merges and permits only an authorized guarded revert PR", () => {
    expect(
      evaluateFixLoopPolicy({
        kind: "post-merge-e2e",
        originalFailurePresent: true,
        newRegressionPresent: false,
        containmentOwner: "maintainer-a",
        badMergeSha: "bad-merge",
        rollbackPrAuthorized: true,
      }),
    ).toMatchObject({
      action: "open-guarded-draft-revert-pr",
      allowedWrites: ["open-draft-revert-pr:bad-merge"],
      deniedWrites: ["revert-main-directly", "merge-dependent-fix", "merge-revert-without-gates"],
      mergeWritesPaused: true,
      nextActor: "maintainer-a",
      queueState: "blocked",
    });
  });

  it("stops all rollback writes when the containment owner lacks authority", () => {
    expect(
      evaluateFixLoopPolicy({
        kind: "post-merge-e2e",
        originalFailurePresent: false,
        newRegressionPresent: true,
        containmentOwner: "maintainer-a",
        badMergeSha: "bad-merge",
        rollbackPrAuthorized: false,
      }),
    ).toMatchObject({
      action: "stop-related-merge-writes-and-request-rollback-authority",
      allowedWrites: [],
      mergeWritesPaused: true,
      nextActor: "maintainer with explicit rollback-PR authority",
      queueState: "blocked",
    });
  });
});
