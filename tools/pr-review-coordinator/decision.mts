// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type CoordinatorAction = "stay-quiet" | "would-request-changes" | "would-approve";

export type CoordinatorFinding = Readonly<{
  id: string;
  contractKey: string;
  severity: "P0" | "P1";
  summary: string;
  path: string;
  validation: "validated" | "ambiguous";
  relationship: "existing-contract" | "newly-proven-on-delta";
}>;

export type CoordinatorSnapshot = Readonly<{
  version: 1;
  pullRequest: Readonly<{
    number: number;
    state: "OPEN" | "CLOSED" | "MERGED";
    draft: boolean;
    author: string;
    reviewer: string;
    headSha: string;
    baseSha: string;
  }>;
  advisor: null | Readonly<{
    identity: "exact-head";
    headSha: string;
    baseSha: string;
    status: "clear" | "blocked";
    findings: readonly CoordinatorFinding[];
  }>;
  readiness: Readonly<{
    requiredChecks: "pass" | "pending" | "fail";
    mergeability: "mergeable" | "conflicting" | "unknown";
    commitsVerified: boolean;
    productScope: "accepted" | "missing";
  }>;
  history: Readonly<{
    frozenContractKeys: readonly string[];
    writes: readonly Readonly<{
      headSha: string;
      kind: "request-changes" | "approve";
    }>[];
  }>;
}>;

export type CoordinatorDecision = Readonly<{
  action: CoordinatorAction;
  reason:
    | "advisor-blockers-first-review"
    | "advisor-clear-and-ready"
    | "advisor-missing-or-stale"
    | "ambiguous-follow-up"
    | "closed-or-draft"
    | "duplicate-current-head-write"
    | "new-material-delta-blocker"
    | "prerequisites-not-ready"
    | "repeated-contract-findings"
    | "self-authored";
  headSha: string;
  findingIds: readonly string[];
  details: string;
}>;

export type ReviewRevision = Readonly<{ headSha: string; baseSha: string }>;

const FULL_SHA = /^[0-9a-f]{40}$/;

export function parseCoordinatorSnapshot(value: unknown): CoordinatorSnapshot {
  validateSnapshot(value);
  return value;
}

/**
 * Pure, side-effect-free policy core for the repository-owned review coordinator.
 * It never writes a review or changes a branch. A later GitHub adapter may execute
 * an action only after re-reading the PR and proving the same exact head/base.
 */
export function decideReviewAction(snapshot: CoordinatorSnapshot): CoordinatorDecision {
  validateSnapshot(snapshot);
  const { pullRequest } = snapshot;
  if (pullRequest.author.toLowerCase() === pullRequest.reviewer.toLowerCase()) {
    return quiet(snapshot, "self-authored", "Reviewer and author roles are not independent.");
  }
  if (pullRequest.state !== "OPEN" || pullRequest.draft) {
    return quiet(
      snapshot,
      "closed-or-draft",
      "The pull request is not an open, ready review target.",
    );
  }
  if (
    snapshot.advisor === null ||
    snapshot.advisor.headSha !== pullRequest.headSha ||
    snapshot.advisor.baseSha !== pullRequest.baseSha
  ) {
    return quiet(
      snapshot,
      "advisor-missing-or-stale",
      "No complete Advisor result is bound to the current head and base.",
    );
  }
  if (snapshot.history.writes.some((write) => write.headSha === pullRequest.headSha)) {
    return quiet(
      snapshot,
      "duplicate-current-head-write",
      "A coordinator review already exists for this exact head.",
    );
  }

  if (snapshot.advisor.status === "blocked") {
    const validated = snapshot.advisor.findings.filter(
      (finding) => finding.validation === "validated",
    );
    const ambiguous = snapshot.advisor.findings.filter(
      (finding) => finding.validation === "ambiguous",
    );
    const frozen = new Set(snapshot.history.frozenContractKeys);

    if (frozen.size === 0 && validated.length > 0) {
      return action(
        snapshot,
        "would-request-changes",
        "advisor-blockers-first-review",
        validated,
        "Publish one consolidated review containing the validated P0/P1 blockers.",
      );
    }

    const newMaterial = validated.filter(
      (finding) =>
        finding.relationship === "newly-proven-on-delta" && !frozen.has(finding.contractKey),
    );
    if (newMaterial.length > 0) {
      return action(
        snapshot,
        "would-request-changes",
        "new-material-delta-blocker",
        newMaterial,
        "Add only validated P0/P1 blockers newly introduced or newly proven by the delta.",
      );
    }
    if (ambiguous.length > 0) {
      return quiet(
        snapshot,
        "ambiguous-follow-up",
        "Follow-up evidence is ambiguous, so the coordinator will not publish or approve.",
      );
    }
    return quiet(
      snapshot,
      "repeated-contract-findings",
      "Only already-reported contract findings remain; do not repeat them.",
    );
  }

  if (!isReady(snapshot.readiness)) {
    return quiet(
      snapshot,
      "prerequisites-not-ready",
      "Advisor is clear, but required checks, mergeability, verification, or product scope is not ready.",
    );
  }
  return action(
    snapshot,
    "would-approve",
    "advisor-clear-and-ready",
    [],
    "Approve only this exact head after a final live head/base and duplicate-write guard.",
  );
}

/** Fail closed when the PR moves between decision and write. */
export function assertUnchangedReviewRevision(
  expected: ReviewRevision,
  live: ReviewRevision,
): void {
  fullSha(expected.headSha, "expected.headSha");
  fullSha(expected.baseSha, "expected.baseSha");
  fullSha(live.headSha, "live.headSha");
  fullSha(live.baseSha, "live.baseSha");
  if (expected.headSha !== live.headSha || expected.baseSha !== live.baseSha) {
    throw new Error("Pull request head or base changed before the review write");
  }
}

function isReady(readiness: CoordinatorSnapshot["readiness"]): boolean {
  return (
    readiness.requiredChecks === "pass" &&
    readiness.mergeability === "mergeable" &&
    readiness.commitsVerified === true &&
    readiness.productScope === "accepted"
  );
}

function action(
  snapshot: CoordinatorSnapshot,
  actionName: Exclude<CoordinatorAction, "stay-quiet">,
  reason: CoordinatorDecision["reason"],
  findings: readonly CoordinatorFinding[],
  details: string,
): CoordinatorDecision {
  return Object.freeze({
    action: actionName,
    reason,
    headSha: snapshot.pullRequest.headSha,
    findingIds: Object.freeze(findings.map(({ id }) => id).sort()),
    details,
  });
}

function quiet(
  snapshot: CoordinatorSnapshot,
  reason: CoordinatorDecision["reason"],
  details: string,
): CoordinatorDecision {
  return Object.freeze({
    action: "stay-quiet",
    reason,
    headSha: snapshot.pullRequest.headSha,
    findingIds: Object.freeze([]),
    details,
  });
}

function validateSnapshot(snapshot: unknown): asserts snapshot is CoordinatorSnapshot {
  if (!isRecord(snapshot)) throw new Error("Coordinator snapshot must be a JSON object");
  if (snapshot.version !== 1) throw new Error("Unsupported coordinator snapshot version");
  const pullRequest = snapshot.pullRequest;
  if (!isRecord(pullRequest)) throw new Error("pullRequest must be a JSON object");
  if (!Number.isInteger(pullRequest.number) || Number(pullRequest.number) < 1) {
    throw new Error("pullRequest.number must be a positive integer");
  }
  if (
    pullRequest.state !== "OPEN" &&
    pullRequest.state !== "CLOSED" &&
    pullRequest.state !== "MERGED"
  ) {
    throw new Error("pullRequest.state is invalid");
  }
  if (typeof pullRequest.draft !== "boolean") {
    throw new Error("pullRequest.draft must be a boolean");
  }
  if (typeof pullRequest.author !== "string" || typeof pullRequest.reviewer !== "string") {
    throw new Error("pullRequest author and reviewer must be strings");
  }
  fullSha(pullRequest.headSha, "pullRequest.headSha");
  fullSha(pullRequest.baseSha, "pullRequest.baseSha");

  const advisor = snapshot.advisor;
  if (advisor !== null) {
    if (!isRecord(advisor)) throw new Error("advisor must be a JSON object or null");
    if (advisor.identity !== "exact-head") throw new Error("Advisor identity is invalid");
    if (advisor.status !== "clear" && advisor.status !== "blocked") {
      throw new Error("Advisor status is invalid");
    }
    fullSha(advisor.headSha, "advisor.headSha");
    fullSha(advisor.baseSha, "advisor.baseSha");
    if (!Array.isArray(advisor.findings)) throw new Error("Advisor findings must be an array");
    if (advisor.status === "clear" && advisor.findings.length > 0) {
      throw new Error("A clear Advisor result cannot contain findings");
    }
    if (advisor.status === "blocked" && advisor.findings.length === 0) {
      throw new Error("A blocked Advisor result must contain findings");
    }
    for (const finding of advisor.findings) {
      if (
        !isRecord(finding) ||
        typeof finding.id !== "string" ||
        !finding.id ||
        typeof finding.contractKey !== "string" ||
        !finding.contractKey ||
        typeof finding.summary !== "string" ||
        !finding.summary ||
        typeof finding.path !== "string" ||
        !finding.path
      ) {
        throw new Error("Advisor findings require id, contractKey, summary, and path");
      }
      if (finding.severity !== "P0" && finding.severity !== "P1") {
        throw new Error("Coordinator accepts only P0/P1 Advisor findings");
      }
      if (finding.validation !== "validated" && finding.validation !== "ambiguous") {
        throw new Error("Advisor finding validation is invalid");
      }
      if (
        finding.relationship !== "existing-contract" &&
        finding.relationship !== "newly-proven-on-delta"
      ) {
        throw new Error("Advisor finding relationship is invalid");
      }
    }
  }

  const readiness = snapshot.readiness;
  if (!isRecord(readiness)) throw new Error("readiness must be a JSON object");
  if (
    readiness.requiredChecks !== "pass" &&
    readiness.requiredChecks !== "pending" &&
    readiness.requiredChecks !== "fail"
  ) {
    throw new Error("readiness.requiredChecks is invalid");
  }
  if (
    readiness.mergeability !== "mergeable" &&
    readiness.mergeability !== "conflicting" &&
    readiness.mergeability !== "unknown"
  ) {
    throw new Error("readiness.mergeability is invalid");
  }
  if (typeof readiness.commitsVerified !== "boolean") {
    throw new Error("readiness.commitsVerified must be a boolean");
  }
  if (readiness.productScope !== "accepted" && readiness.productScope !== "missing") {
    throw new Error("readiness.productScope is invalid");
  }

  const history = snapshot.history;
  if (!isRecord(history)) throw new Error("history must be a JSON object");
  if (
    !Array.isArray(history.frozenContractKeys) ||
    history.frozenContractKeys.some((key) => typeof key !== "string")
  ) {
    throw new Error("history.frozenContractKeys must be an array of strings");
  }
  if (!Array.isArray(history.writes)) throw new Error("history.writes must be an array");
  for (const write of history.writes) {
    if (!isRecord(write)) throw new Error("history writes must be JSON objects");
    fullSha(write.headSha, "history.writes.headSha");
    if (write.kind !== "request-changes" && write.kind !== "approve") {
      throw new Error("history write kind is invalid");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a full lowercase commit SHA`);
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be a full lowercase commit SHA`);
  return value;
}
