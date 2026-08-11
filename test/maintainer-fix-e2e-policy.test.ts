// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

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
        checksHead: "head-b",
        requiredChecksPass: true,
      }),
    ).toMatchObject({
      action: "route-to-independent-current-head-reviewer",
      allowedWrites: [],
      deniedWrites: ["submit-approval"],
      queueState: "waiting-review",
    });
  });

  it.each([
    ["pending", "head-b", false],
    ["failing", "head-b", false],
    ["stale", "head-a", true],
  ])("denies current-head approval when required checks are %s", (_state, checksHead, pass) => {
    expect(
      evaluateFixLoopPolicy({
        kind: "review",
        actor: "independent-reviewer",
        opener: "fix-author",
        authors: ["fix-author"],
        currentHead: "head-b",
        reviewedHead: "head-b",
        checksHead,
        requiredChecksPass: pass,
      }),
    ).toMatchObject({
      action: "wait-for-current-head-required-checks",
      allowedWrites: [],
      deniedWrites: ["submit-approval"],
      queueState: "waiting-ci",
    });
  });

  it("allows independent approval only after required checks pass on the reviewed head", () => {
    expect(
      evaluateFixLoopPolicy({
        kind: "review",
        actor: "independent-reviewer",
        opener: "fix-author",
        authors: ["fix-author"],
        currentHead: "head-b",
        reviewedHead: "head-b",
        checksHead: "head-b",
        requiredChecksPass: true,
      }),
    ).toMatchObject({
      action: "submit-current-head-approval",
      allowedWrites: ["submit-approval"],
      queueState: "approval-ready",
    });
  });

  it("verifies the policy execution surface before invoking the trusted worktree copy", () => {
    const guide = fs.readFileSync(
      new URL(
        "../.agents/skills/nemoclaw-maintainer-fix-e2e-failures/references/review-and-merge.md",
        import.meta.url,
      ),
      "utf8",
    );
    const trustCheck = guide.indexOf('cmp -s "$trusted_policy_root/$policy_file" "$policy_file"');
    const trustedInvocation = guide.indexOf('"$trusted_policy_root/$policy_path"');

    expect(guide).toContain("every transitive local import");
    expect(trustCheck).toBeGreaterThanOrEqual(0);
    expect(trustedInvocation).toBeGreaterThan(trustCheck);
  });

  it("fails closed before the final gate and invokes only the compared trusted copy", () => {
    const guide = fs.readFileSync(
      new URL(
        "../.agents/skills/nemoclaw-maintainer-fix-e2e-failures/references/review-and-merge.md",
        import.meta.url,
      ),
      "utf8",
    );
    const finalGate = guide.slice(
      guide.indexOf("## Final Merge Gate"),
      guide.indexOf("## Merge Without Bypass"),
    );
    const trustCheck = finalGate.indexOf('cmp -s "$trusted_gate_root/$gate_file" "$gate_file"');
    const trustedInvocation = finalGate.indexOf('"$trusted_gate_root/$gate_path" <pr-number>');

    expect(finalGate).toContain("set -euo pipefail");
    expect(finalGate).toContain('gate_surface=("$gate_path" "$gate_shared_path")');
    expect(finalGate).toContain('test -z "$(git status --porcelain -- "${gate_surface[@]}")"');
    expect(finalGate).toContain("If either file differs");
    expect(trustCheck).toBeGreaterThanOrEqual(0);
    expect(trustedInvocation).toBeGreaterThan(trustCheck);
    expect(finalGate).not.toContain(
      "  .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>",
    );
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
