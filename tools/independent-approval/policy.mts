// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const INDEPENDENT_APPROVAL_CHECK = "independent-human-approval";
export const LEDGER_MARKER = "nemoclaw-independent-approval-ledger:v1";

const DECISIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const DEFAULT_ELIGIBLE_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export type ContributorReason =
  | "pr_opener"
  | "commit_author"
  | "commit_committer"
  | "coauthor"
  | "push_actor";

export interface GitHubIdentity {
  id: number | null;
  login: string;
  type: string;
}

export interface ContributorIdentity extends GitHubIdentity {
  reasons: ContributorReason[];
}

export interface ContributorObservation {
  version: 1;
  prNumber: number;
  headSha: string;
  beforeSha: string | null;
  eventId: string;
  observedAt: string;
  eventAction: string;
  contributors: ContributorIdentity[];
}

export interface ApprovalReview {
  id: number;
  state: string;
  commitId: string | null;
  submittedAt: string;
  reviewer: GitHubIdentity | null;
  permission: string | null;
}

export type ApprovalRejectionReason =
  | "not_current_head"
  | "predates_latest_push"
  | "not_human_user"
  | "service_account"
  | "insufficient_permission"
  | "pr_contributor";

export interface RejectedApproval {
  login: string;
  reviewId: number;
  reasons: ApprovalRejectionReason[];
}

export interface IndependentApprovalResult {
  pass: boolean;
  reason: "approved" | "missing_current_head_observation" | "no_qualifying_independent_approval";
  qualifyingApprovals: Array<{ login: string; reviewId: number }>;
  rejectedApprovals: RejectedApproval[];
  contributors: ContributorIdentity[];
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function identityKey(identity: Pick<GitHubIdentity, "id" | "login">): string {
  if (Number.isInteger(identity.id) && (identity.id ?? 0) > 0) return `id:${identity.id}`;
  return `login:${normalizeLogin(identity.login)}`;
}

function normalizeIdentity(identity: GitHubIdentity): GitHubIdentity {
  return {
    id: Number.isInteger(identity.id) && (identity.id ?? 0) > 0 ? identity.id : null,
    login: normalizeLogin(identity.login),
    type: identity.type.trim(),
  };
}

export function mergeContributors(
  contributorGroups: ReadonlyArray<ReadonlyArray<ContributorIdentity>>,
): ContributorIdentity[] {
  const merged = new Map<string, ContributorIdentity>();

  for (const contributors of contributorGroups) {
    for (const contributor of contributors) {
      const normalized = normalizeIdentity(contributor);
      if (!normalized.login) continue;
      const key = identityKey(normalized);
      const existing = merged.get(key);
      const reasons = new Set<ContributorReason>([
        ...(existing?.reasons ?? []),
        ...contributor.reasons,
      ]);
      merged.set(key, { ...normalized, reasons: [...reasons].sort() });
    }
  }

  return [...merged.values()].sort((left, right) => left.login.localeCompare(right.login));
}

function compareReviews(left: ApprovalReview, right: ApprovalReview): number {
  const byTime = left.submittedAt.localeCompare(right.submittedAt);
  return byTime === 0 ? left.id - right.id : byTime;
}

export function latestDecisiveReviews(reviews: ReadonlyArray<ApprovalReview>): ApprovalReview[] {
  const latest = new Map<string, ApprovalReview>();

  for (const review of [...reviews].sort(compareReviews)) {
    const state = review.state.toUpperCase();
    if (!DECISIVE_REVIEW_STATES.has(state) || !review.reviewer) continue;
    const reviewer = normalizeIdentity(review.reviewer);
    if (!reviewer.login) continue;
    latest.set(identityKey(reviewer), { ...review, state, reviewer });
  }

  return [...latest.values()];
}

export function evaluateIndependentApproval(input: {
  headSha: string;
  currentContributors: ReadonlyArray<ContributorIdentity>;
  observations: ReadonlyArray<ContributorObservation>;
  reviews: ReadonlyArray<ApprovalReview>;
  serviceAccountLogins?: ReadonlyArray<string>;
  eligiblePermissions?: ReadonlyArray<string>;
}): IndependentApprovalResult {
  const contributors = mergeContributors([
    input.currentContributors,
    ...input.observations.map((observation) => observation.contributors),
  ]);
  const contributorKeys = new Set(contributors.map(identityKey));
  const currentHeadObservations = input.observations.filter(
    (observation) => observation.headSha === input.headSha,
  );
  const currentHeadObserved = currentHeadObservations.length > 0;

  if (!currentHeadObserved) {
    return {
      pass: false,
      reason: "missing_current_head_observation",
      qualifyingApprovals: [],
      rejectedApprovals: [],
      contributors,
    };
  }

  const serviceAccounts = new Set((input.serviceAccountLogins ?? []).map(normalizeLogin));
  const latestCurrentHeadObservation = currentHeadObservations
    .map((observation) => observation.observedAt)
    .sort()
    .at(-1) as string;
  const eligiblePermissions = new Set(
    (input.eligiblePermissions ?? [...DEFAULT_ELIGIBLE_PERMISSIONS]).map((permission) =>
      permission.toLowerCase(),
    ),
  );
  const qualifyingApprovals: Array<{ login: string; reviewId: number }> = [];
  const rejectedApprovals: RejectedApproval[] = [];

  for (const review of latestDecisiveReviews(input.reviews)) {
    if (review.state !== "APPROVED" || !review.reviewer) continue;
    const reasons: ApprovalRejectionReason[] = [];
    const reviewer = review.reviewer;

    if (review.commitId !== input.headSha) reasons.push("not_current_head");
    if (review.submittedAt <= latestCurrentHeadObservation) {
      reasons.push("predates_latest_push");
    }
    if (reviewer.type !== "User") reasons.push("not_human_user");
    if (serviceAccounts.has(normalizeLogin(reviewer.login))) reasons.push("service_account");
    if (!review.permission || !eligiblePermissions.has(review.permission.toLowerCase())) {
      reasons.push("insufficient_permission");
    }
    if (contributorKeys.has(identityKey(reviewer))) reasons.push("pr_contributor");

    if (reasons.length === 0) {
      qualifyingApprovals.push({ login: reviewer.login, reviewId: review.id });
    } else {
      rejectedApprovals.push({ login: reviewer.login, reviewId: review.id, reasons });
    }
  }

  return {
    pass: qualifyingApprovals.length > 0,
    reason: qualifyingApprovals.length > 0 ? "approved" : "no_qualifying_independent_approval",
    qualifyingApprovals,
    rejectedApprovals,
    contributors,
  };
}

function isContributorReason(value: unknown): value is ContributorReason {
  return ["pr_opener", "commit_author", "commit_committer", "coauthor", "push_actor"].includes(
    String(value),
  );
}

export function parseObservationComment(body: string): ContributorObservation | null {
  const prefix = `<!-- ${LEDGER_MARKER}\n`;
  const start = body.indexOf(prefix);
  if (start < 0) return null;
  const end = body.indexOf("\n-->", start + prefix.length);
  if (end < 0) return null;

  try {
    const parsed = JSON.parse(body.slice(start + prefix.length, end)) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.prNumber) ||
      (parsed.prNumber as number) <= 0 ||
      typeof parsed.headSha !== "string" ||
      !SHA_PATTERN.test(parsed.headSha) ||
      !(
        parsed.beforeSha === null ||
        (typeof parsed.beforeSha === "string" && SHA_PATTERN.test(parsed.beforeSha))
      ) ||
      typeof parsed.eventId !== "string" ||
      !/^[0-9]+$/u.test(parsed.eventId) ||
      typeof parsed.observedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.observedAt)) ||
      typeof parsed.eventAction !== "string" ||
      !["opened", "synchronize"].includes(parsed.eventAction) ||
      !Array.isArray(parsed.contributors)
    ) {
      return null;
    }

    const contributors: ContributorIdentity[] = [];
    for (const value of parsed.contributors) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const contributor = value as Record<string, unknown>;
      if (
        !(
          contributor.id === null ||
          (Number.isInteger(contributor.id) && (contributor.id as number) > 0)
        ) ||
        typeof contributor.login !== "string" ||
        !contributor.login.trim() ||
        typeof contributor.type !== "string" ||
        !contributor.type.trim() ||
        !Array.isArray(contributor.reasons) ||
        !contributor.reasons.every(isContributorReason)
      ) {
        return null;
      }
      contributors.push({
        id: contributor.id as number | null,
        login: contributor.login,
        type: contributor.type,
        reasons: contributor.reasons,
      });
    }

    return {
      version: 1,
      prNumber: parsed.prNumber as number,
      headSha: parsed.headSha,
      beforeSha: parsed.beforeSha as string | null,
      eventId: parsed.eventId,
      observedAt: parsed.observedAt,
      eventAction: parsed.eventAction,
      contributors,
    };
  } catch {
    return null;
  }
}

export function renderObservationComment(observation: ContributorObservation): string {
  const logins = observation.contributors.map((contributor) => `@${contributor.login}`).join(", ");
  return [
    `<!-- ${LEDGER_MARKER}`,
    JSON.stringify(observation),
    "-->",
    `<sub>Independent-approval ledger recorded ${observation.eventAction} at \`${observation.headSha.slice(0, 12)}\` for ${logins || "no mapped contributors"}. This append-only observation preserves reviewer eligibility across later rebases and force-pushes.</sub>`,
  ].join("\n");
}
