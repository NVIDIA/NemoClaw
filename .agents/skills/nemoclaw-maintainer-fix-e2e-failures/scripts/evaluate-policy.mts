// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export type FixLoopQueueState =
  | "active"
  | "waiting-ci"
  | "waiting-review"
  | "approval-ready"
  | "blocked"
  | "merged";

export type FixLoopPolicyDecision = {
  action: string;
  allowedWrites: string[];
  deniedWrites: string[];
  mergeWritesPaused: boolean;
  nextActor: string;
  queueState: FixLoopQueueState;
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

function decision(overrides: Partial<FixLoopPolicyDecision>): FixLoopPolicyDecision {
  return {
    action: "record-blocker",
    allowedWrites: [],
    deniedWrites: [],
    mergeWritesPaused: false,
    nextActor: "fix-loop owner",
    queueState: "blocked",
    reason: "The requested write did not satisfy the executable policy.",
    ...overrides,
  };
}

function evaluateAmbiguousWrite(state: JsonRecord): FixLoopPolicyDecision {
  const writeKind = requiredString(state, "writeKind");
  const reconciliation = requiredString(state, "reconciliation");
  const identitiesUnchanged = requiredBoolean(state, "identitiesUnchanged");
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
    identitiesUnchanged &&
    retryCount === 0 &&
    !transferStarted
  ) {
    return decision({
      action: "retry-same-write-once",
      allowedWrites: [retryWrite],
      queueState: "active",
      reason: "One retry is allowed after read-only reconciliation preserves every identity.",
    });
  }
  return decision({
    action: "record-ambiguous-write-blocker",
    deniedWrites: [retryWrite],
    reason: "The write remains uncertain, an identity changed, a retry ran, or transfer started.",
  });
}

function evaluateForkApproval(state: JsonRecord): FixLoopPolicyDecision {
  const safe =
    requiredBoolean(state, "ordinaryPullRequestWorkflow") &&
    requiredBoolean(state, "expectedRepository") &&
    requiredBoolean(state, "currentHead") &&
    requiredBoolean(state, "completeDiffReviewed") &&
    !requiredBoolean(state, "sensitiveWorkflowChanged") &&
    !requiredBoolean(state, "exposesPrivilegedCredentials") &&
    requiredBoolean(state, "authorized") &&
    requiredString(state, "runState") === "action_required";

  return safe
    ? decision({
        action: "approve-ordinary-fork-workflow",
        allowedWrites: ["approve-workflow-run"],
        queueState: "active",
        reason: "The ordinary untrusted-fork workflow and exact head passed the trust review.",
      })
    : decision({
        action: "record-fork-approval-blocker-and-continue",
        deniedWrites: ["approve-workflow-run", "dispatch-privileged-e2e"],
        reason: "The workflow identity, exact head, trust review, or authority is incomplete.",
      });
}

function evaluateReview(state: JsonRecord): FixLoopPolicyDecision {
  const actor = requiredString(state, "actor");
  const opener = requiredString(state, "opener");
  const authors = requiredStringArray(state, "authors");
  const currentHead = requiredString(state, "currentHead");
  const reviewedHead = requiredString(state, "reviewedHead");
  const independent = actor !== opener && !authors.includes(actor);

  return independent && currentHead === reviewedHead
    ? decision({
        action: "submit-current-head-approval",
        allowedWrites: ["submit-approval"],
        queueState: "waiting-ci",
        reason: "A non-contributor reviewed the current head.",
      })
    : decision({
        action: "route-to-independent-current-head-reviewer",
        deniedWrites: ["submit-approval"],
        nextActor: "independent maintainer",
        queueState: "waiting-review",
        reason: independent
          ? "The reviewed head is stale."
          : "The PR opener, author, or co-author cannot provide the independent approval.",
      });
}

function evaluateMerge(state: JsonRecord): FixLoopPolicyDecision {
  const capturedHead = requiredString(state, "capturedHead");
  const currentHead = requiredString(state, "currentHead");
  const approvedHead = requiredString(state, "approvedHead");
  const checksHead = requiredString(state, "checksHead");
  const eligible =
    capturedHead === currentHead &&
    approvedHead === currentHead &&
    checksHead === currentHead &&
    requiredBoolean(state, "baseCurrent") &&
    requiredBoolean(state, "requiredChecksPass") &&
    requiredBoolean(state, "independentApproval") &&
    requiredBoolean(state, "mergeable") &&
    requiredBoolean(state, "mergeAuthorized");

  return eligible
    ? decision({
        action: "merge-exact-reviewed-head",
        allowedWrites: [`merge:${currentHead}`],
        queueState: "merged",
        reason: "The current head, checks, approval, base, rules, and authority agree.",
      })
    : decision({
        action: "restart-final-merge-gate",
        deniedWrites: [`merge:${capturedHead}`],
        queueState: "waiting-review",
        reason: "A head, check, approval, base, rule, mergeability, or authority gate is stale.",
      });
}

function evaluatePostMerge(state: JsonRecord): FixLoopPolicyDecision {
  const originalFailurePresent = requiredBoolean(state, "originalFailurePresent");
  const newRegressionPresent = requiredBoolean(state, "newRegressionPresent");
  const containmentOwner = requiredString(state, "containmentOwner");
  const badMergeSha = requiredString(state, "badMergeSha");
  const rollbackPrAuthorized = requiredBoolean(state, "rollbackPrAuthorized");
  if (!originalFailurePresent && !newRegressionPresent) {
    return decision({
      action: "record-post-merge-verification",
      nextActor: containmentOwner,
      queueState: "merged",
      reason: "The automatic main evidence contains neither the original failure nor a new regression.",
    });
  }

  return rollbackPrAuthorized
    ? decision({
        action: "open-guarded-draft-revert-pr",
        allowedWrites: [`open-draft-revert-pr:${badMergeSha}`],
        deniedWrites: ["revert-main-directly", "merge-dependent-fix", "merge-revert-without-gates"],
        mergeWritesPaused: true,
        nextActor: containmentOwner,
        reason: "A post-merge failure pauses related merges; rollback is a reviewed draft PR only.",
      })
    : decision({
        action: "stop-related-merge-writes-and-request-rollback-authority",
        deniedWrites: [
          "revert-main-directly",
          `open-draft-revert-pr:${badMergeSha}`,
          "merge-dependent-fix",
        ],
        mergeWritesPaused: true,
        nextActor: "maintainer with explicit rollback-PR authority",
        reason: "The containment owner lacks authority to create the guarded rollback PR.",
      });
}

export function evaluateFixLoopPolicy(input: unknown): FixLoopPolicyDecision {
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
      throw new Error("kind must name a supported fix-loop policy scenario");
  }
}

function runFromStdin(): void {
  const input = JSON.parse(fs.readFileSync(0, "utf8")) as unknown;
  process.stdout.write(`${JSON.stringify(evaluateFixLoopPolicy(input), null, 2)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) runFromStdin();
