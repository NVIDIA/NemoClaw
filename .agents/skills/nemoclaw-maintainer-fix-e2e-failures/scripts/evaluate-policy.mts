// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export type E2eMaintenanceQueueState =
  | "active"
  | "waiting-ci"
  | "waiting-review"
  | "approval-ready"
  | "blocked"
  | "merged";

export type E2eMaintenancePolicyDecision = {
  action: string;
  allowedWrites: string[];
  deniedWrites: string[];
  mergeWritesPaused: boolean;
  nextActor: string;
  queueState: E2eMaintenanceQueueState;
  reason: string;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function requiredString(state: JsonRecord, key: string): string {
  const value = state[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a nonempty string`);
  }
  return value;
}

function requiredBoolean(state: JsonRecord, key: string): boolean {
  const value = state[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function requiredStringArray(state: JsonRecord, key: string): string[] {
  const value = state[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function decision(overrides: Partial<E2eMaintenancePolicyDecision>): E2eMaintenancePolicyDecision {
  return {
    action: "record-blocker",
    allowedWrites: [],
    deniedWrites: [],
    mergeWritesPaused: false,
    nextActor: "E2E maintenance owner",
    queueState: "blocked",
    reason: "The requested write did not satisfy the executable policy.",
    ...overrides,
  };
}

function evaluateAmbiguousWrite(state: JsonRecord): E2eMaintenancePolicyDecision {
  const writeKind = requiredString(state, "writeKind");
  const reconciliation = requiredString(state, "reconciliation");
  const objectIdentifiersUnchanged = requiredBoolean(state, "objectIdentifiersUnchanged");
  const retryCount = state.retryCount;
  const transferStarted = requiredBoolean(state, "transferStarted");
  if (!Number.isInteger(retryCount) || Number(retryCount) < 0) {
    throw new Error("retryCount must be a nonnegative integer");
  }
  const retryWrite = `retry:${writeKind}`;

  if (reconciliation === "not-run") {
    return decision({
      action: "reconcile-read-only",
      deniedWrites: [retryWrite],
      queueState: "active",
      reason: "An ambiguous GitHub write must be reconciled before any retry.",
    });
  }
  if (reconciliation === "observed-applied") {
    return decision({
      action: "continue-from-observed-state",
      deniedWrites: [retryWrite],
      queueState: "active",
      reason: "The intended write is already present remotely.",
    });
  }
  if (
    reconciliation === "observed-not-applied" &&
    objectIdentifiersUnchanged &&
    retryCount === 0 &&
    !transferStarted
  ) {
    return decision({
      action: "retry-same-write-once",
      allowedWrites: [retryWrite],
      queueState: "active",
      reason:
        "One retry is allowed after read-only reconciliation shows every object identifier unchanged.",
    });
  }
  return decision({
    action: "record-ambiguous-write-blocker",
    deniedWrites: [retryWrite],
    reason:
      "The write remains uncertain, an object identifier changed, a retry ran, or transfer started.",
  });
}

function evaluateForkApproval(state: JsonRecord): E2eMaintenancePolicyDecision {
  const approvalPermitted =
    requiredBoolean(state, "ordinaryPullRequestWorkflow") &&
    requiredBoolean(state, "expectedRepository") &&
    requiredBoolean(state, "latestPrCommit") &&
    requiredBoolean(state, "completeDiffReviewed") &&
    !requiredBoolean(state, "sensitiveWorkflowChanged") &&
    !requiredBoolean(state, "exposesPrivilegedCredentials") &&
    requiredBoolean(state, "authorized") &&
    requiredString(state, "runState") === "action_required";

  return approvalPermitted
    ? decision({
        action: "approve-ordinary-fork-workflow",
        allowedWrites: ["approve-workflow-run"],
        queueState: "active",
        reason:
          "The ordinary untrusted-fork workflow and latest PR commit passed the trust review.",
      })
    : decision({
        action: "record-fork-approval-blocker-and-continue",
        deniedWrites: ["approve-workflow-run", "dispatch-privileged-e2e"],
        reason:
          "The workflow identifiers, latest PR commit, trust review, or authorization are incomplete.",
      });
}

function evaluateReview(state: JsonRecord): E2eMaintenancePolicyDecision {
  const actor = requiredString(state, "actor");
  const opener = requiredString(state, "opener");
  const authors = requiredStringArray(state, "authors");
  const latestPrCommitSha = requiredString(state, "latestPrCommitSha");
  const reviewedCommitSha = requiredString(state, "reviewedCommitSha");
  const checksCommitSha = requiredString(state, "checksCommitSha");
  const requiredChecksPass = requiredBoolean(state, "requiredChecksPass");
  const normalizedActor = normalizeLogin(actor);
  const independent =
    normalizedActor !== normalizeLogin(opener) &&
    !authors.some((author) => normalizeLogin(author) === normalizedActor);

  if (!independent || latestPrCommitSha !== reviewedCommitSha) {
    return decision({
      action: "route-to-independent-reviewer",
      deniedWrites: ["submit-approval"],
      nextActor: "independent maintainer",
      queueState: "waiting-review",
      reason: independent
        ? "The latest PR commit differs from the commit under review."
        : "The PR opener, author, or co-author cannot provide the independent approval.",
    });
  }
  if (checksCommitSha !== latestPrCommitSha || !requiredChecksPass) {
    return decision({
      action: "wait-for-latest-pr-commit-required-checks",
      deniedWrites: ["submit-approval"],
      queueState: "waiting-ci",
      reason: "Required checks are stale, pending, or failing for the latest PR commit.",
    });
  }
  return decision({
    action: "submit-independent-approval",
    allowedWrites: ["submit-approval"],
    queueState: "approval-ready",
    reason: "A non-contributor reviewed the latest PR commit, and its required checks pass.",
  });
}

function evaluateMerge(state: JsonRecord): E2eMaintenancePolicyDecision {
  const capturedCommitSha = requiredString(state, "capturedCommitSha");
  const latestPrCommitSha = requiredString(state, "latestPrCommitSha");
  const approvedCommitSha = requiredString(state, "approvedCommitSha");
  const checksCommitSha = requiredString(state, "checksCommitSha");
  const eligible =
    capturedCommitSha === latestPrCommitSha &&
    approvedCommitSha === latestPrCommitSha &&
    checksCommitSha === latestPrCommitSha &&
    requiredBoolean(state, "baseMatchesMain") &&
    requiredBoolean(state, "requiredChecksPass") &&
    requiredBoolean(state, "independentApproval") &&
    requiredBoolean(state, "mergeable") &&
    requiredBoolean(state, "mergeAuthorized");

  return eligible
    ? decision({
        action: "merge-commit-under-review",
        allowedWrites: [`merge:${latestPrCommitSha}`],
        queueState: "merged",
        reason: "The latest PR commit, checks, approval, base, rules, and authorization agree.",
      })
    : decision({
        action: "restart-final-merge-gate",
        deniedWrites: [`merge:${capturedCommitSha}`],
        queueState: "waiting-review",
        reason:
          "A commit SHA, check, approval, base SHA, rule, merge state, or authorization no longer satisfies the final merge requirements.",
      });
}

function evaluatePostMerge(state: JsonRecord): E2eMaintenancePolicyDecision {
  const originalFailurePresent = requiredBoolean(state, "originalFailurePresent");
  const newRegressionPresent = requiredBoolean(state, "newRegressionPresent");
  const containmentOwner = requiredString(state, "containmentOwner");
  const failedMergeSha = requiredString(state, "failedMergeSha");
  const rollbackPrAuthorized = requiredBoolean(state, "rollbackPrAuthorized");
  const attributionCertain = requiredBoolean(state, "attributionCertain");
  if (!originalFailurePresent && !newRegressionPresent) {
    return decision({
      action: "record-post-merge-verification",
      nextActor: containmentOwner,
      queueState: "merged",
      reason:
        "The automatic E2E evidence for main contains neither the original failure nor a new regression.",
    });
  }

  if (!attributionCertain) {
    return decision({
      action: "stop-related-merge-writes-and-review-attribution",
      deniedWrites: [
        "revert-main-directly",
        `open-draft-revert-pr:${failedMergeSha}`,
        "merge-dependent-fix",
        "merge-revert-without-gates",
      ],
      mergeWritesPaused: true,
      nextActor: "maintainer reviewing failure attribution",
      reason:
        "Rollback writes remain denied until evidence attributes the failure to the named merge commit.",
    });
  }

  return rollbackPrAuthorized
    ? decision({
        action: "open-authorized-draft-revert-pr",
        allowedWrites: [`open-draft-revert-pr:${failedMergeSha}`],
        deniedWrites: ["revert-main-directly", "merge-dependent-fix", "merge-revert-without-gates"],
        mergeWritesPaused: true,
        nextActor: containmentOwner,
        reason: "A post-merge failure pauses related merges; rollback is a reviewed draft PR only.",
      })
    : decision({
        action: "stop-related-merge-writes-and-request-rollback-authorization",
        deniedWrites: [
          "revert-main-directly",
          `open-draft-revert-pr:${failedMergeSha}`,
          "merge-dependent-fix",
          "merge-revert-without-gates",
        ],
        mergeWritesPaused: true,
        nextActor: "maintainer with explicit authorization to create a rollback PR",
        reason: "The containment owner lacks authorization to create the draft rollback PR.",
      });
}

export function evaluateE2eMaintenancePolicy(input: unknown): E2eMaintenancePolicyDecision {
  const state = asRecord(input, "policy state");
  switch (requiredString(state, "kind")) {
    case "ambiguous-write":
      return evaluateAmbiguousWrite(state);
    case "fork-workflow-approval":
      return evaluateForkApproval(state);
    case "review":
      return evaluateReview(state);
    case "merge":
      return evaluateMerge(state);
    case "post-merge-e2e":
      return evaluatePostMerge(state);
    default:
      throw new Error("kind must name a supported E2E maintenance policy scenario");
  }
}

function runFromStdin(): void {
  const input = JSON.parse(fs.readFileSync(0, "utf8")) as unknown;
  process.stdout.write(`${JSON.stringify(evaluateE2eMaintenancePolicy(input), null, 2)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) runFromStdin();
