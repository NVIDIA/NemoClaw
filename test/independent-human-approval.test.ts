// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type ApprovalReview,
  type ContributorIdentity,
  type ContributorObservation,
  evaluateIndependentApproval,
  parseObservationComment,
  renderObservationComment,
} from "../tools/independent-approval/policy.mts";

const HEAD = "4d52e7adb2b37409da02f29d046fbe546855f37b";
const PRIOR_HEAD = "f25bac9555ea598825f3df140cef93be96e0b0cb";

const users = {
  apurv: { id: 36614, login: "apurvvkumaria", type: "User" },
  carlos: { id: 5445, login: "cv", type: "User" },
  claude: { id: 81847, login: "claude", type: "User" },
  coderabbit: { id: 136622811, login: "coderabbitai[bot]", type: "Bot" },
  tinson: { id: 6479328, login: "laitingsheng", type: "User" },
} as const;

function contributor(
  user: (typeof users)[keyof typeof users],
  reasons: ContributorIdentity["reasons"],
): ContributorIdentity {
  return { ...user, reasons };
}

function observation(contributors: ContributorIdentity[], headSha = HEAD): ContributorObservation {
  return {
    version: 1,
    prNumber: 6202,
    headSha,
    beforeSha: headSha === HEAD ? PRIOR_HEAD : null,
    eventId: headSha === HEAD ? "1001" : "1002",
    observedAt: "2026-07-03T00:00:00Z",
    eventAction: "synchronize",
    contributors,
  };
}

function approval(
  id: number,
  reviewer: ApprovalReview["reviewer"],
  overrides: Partial<ApprovalReview> = {},
): ApprovalReview {
  return {
    id,
    state: "APPROVED",
    commitId: HEAD,
    submittedAt: `2026-07-03T00:${String(id).padStart(2, "0")}:00Z`,
    reviewer,
    permission: "write",
    ...overrides,
  };
}

function evaluate(
  overrides: {
    currentContributors?: ContributorIdentity[];
    observations?: ContributorObservation[];
    reviews?: ApprovalReview[];
    serviceAccountLogins?: string[];
  } = {},
) {
  return evaluateIndependentApproval({
    headSha: HEAD,
    currentContributors: overrides.currentContributors ?? [
      contributor(users.tinson, ["pr_opener", "commit_author"]),
    ],
    observations: overrides.observations ?? [
      observation([contributor(users.tinson, ["pr_opener", "commit_author"])]),
    ],
    reviews: overrides.reviews ?? [],
    serviceAccountLogins: overrides.serviceAccountLogins ?? ["claude"],
  });
}

describe("independent human approval policy", () => {
  it("rejects the reviewer-to-contributor-to-approver sequence from PR 6202 (#6222)", () => {
    const apurv = contributor(users.apurv, ["commit_author", "commit_committer", "push_actor"]);
    const result = evaluate({
      currentContributors: [contributor(users.tinson, ["pr_opener"]), apurv],
      observations: [observation([contributor(users.tinson, ["pr_opener"]), apurv])],
      reviews: [approval(1, users.apurv)],
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toBe("no_qualifying_independent_approval");
    expect(result.rejectedApprovals).toEqual([
      { login: "apurvvkumaria", reviewId: 1, reasons: ["pr_contributor"] },
    ]);
  });

  it("accepts one current-head approval from an independent writer (#6222)", () => {
    const result = evaluate({ reviews: [approval(2, users.carlos)] });

    expect(result.pass).toBe(true);
    expect(result.qualifyingApprovals).toEqual([{ login: "cv", reviewId: 2 }]);
  });

  it.each([
    "pr_opener",
    "commit_author",
    "commit_committer",
    "coauthor",
    "push_actor",
  ] as const)("rejects an approver recorded as %s (#6222)", (reason) => {
    const apurv = contributor(users.apurv, [reason]);
    const result = evaluate({
      currentContributors: [contributor(users.tinson, ["pr_opener"]), apurv],
      observations: [observation([contributor(users.tinson, ["pr_opener"]), apurv])],
      reviews: [approval(1, users.apurv)],
    });

    expect(result.pass).toBe(false);
    expect(result.rejectedApprovals[0]?.reasons).toContain("pr_contributor");
  });

  it("requires only one new independent approval while retaining earlier reviews (#6222)", () => {
    const result = evaluate({
      reviews: [
        approval(1, users.carlos, { commitId: PRIOR_HEAD }),
        approval(2, users.apurv, { commitId: PRIOR_HEAD }),
        approval(3, users.carlos),
      ],
    });

    expect(result.pass).toBe(true);
    expect(result.qualifyingApprovals).toEqual([{ login: "cv", reviewId: 3 }]);
  });

  it("does not treat an approval on an earlier head as current (#6222)", () => {
    const result = evaluate({
      reviews: [approval(1, users.carlos, { commitId: PRIOR_HEAD })],
    });

    expect(result.pass).toBe(false);
    expect(result.rejectedApprovals[0]?.reasons).toContain("not_current_head");
  });

  it("uses the latest decisive review and ignores later comments (#6222)", () => {
    const result = evaluate({
      reviews: [
        approval(1, users.carlos),
        approval(2, users.carlos, { state: "COMMENTED" }),
        approval(3, users.carlos, { state: "CHANGES_REQUESTED" }),
      ],
    });

    expect(result.pass).toBe(false);
    expect(result.qualifyingApprovals).toEqual([]);
  });

  it("stops counting an approval as soon as GitHub reports it dismissed (#6222)", () => {
    const result = evaluate({
      reviews: [approval(1, users.carlos, { state: "DISMISSED" })],
    });

    expect(result.pass).toBe(false);
    expect(result.qualifyingApprovals).toEqual([]);
  });

  it("rejects bots, service accounts, and reviewers without write permission (#6222)", () => {
    const result = evaluate({
      reviews: [
        approval(1, users.coderabbit),
        approval(2, users.claude),
        approval(3, users.carlos, { permission: "read" }),
      ],
    });

    expect(result.pass).toBe(false);
    expect(result.rejectedApprovals).toEqual([
      { login: "coderabbitai[bot]", reviewId: 1, reasons: ["not_human_user"] },
      { login: "claude", reviewId: 2, reasons: ["service_account"] },
      { login: "cv", reviewId: 3, reasons: ["insufficient_permission"] },
    ]);
  });

  it("keeps a removed contributor ineligible through the append-only ledger (#6222)", () => {
    const result = evaluate({
      currentContributors: [contributor(users.tinson, ["pr_opener"])],
      observations: [
        observation([contributor(users.apurv, ["commit_author", "push_actor"])], PRIOR_HEAD),
        observation([contributor(users.tinson, ["pr_opener"])]),
      ],
      reviews: [approval(1, users.apurv)],
    });

    expect(result.pass).toBe(false);
    expect(result.contributors.find(({ login }) => login === "apurvvkumaria")?.reasons).toEqual([
      "commit_author",
      "push_actor",
    ]);
  });

  it("does not resurrect an old approval when a branch returns to an earlier SHA (#6222)", () => {
    const original = observation([contributor(users.tinson, ["pr_opener"])]);
    const replay = {
      ...observation([contributor(users.tinson, ["pr_opener"])]),
      beforeSha: PRIOR_HEAD,
      eventId: "1003",
      observedAt: "2026-07-03T00:20:00Z",
    };
    const result = evaluate({
      observations: [original, replay],
      reviews: [
        approval(1, users.carlos, {
          submittedAt: "2026-07-03T00:10:00Z",
        }),
      ],
    });

    expect(result.pass).toBe(false);
    expect(result.rejectedApprovals[0]?.reasons).toContain("predates_latest_push");
  });

  it("fails closed when no ledger observation covers the current head (#6222)", () => {
    const result = evaluate({
      observations: [observation([contributor(users.tinson, ["pr_opener"])], PRIOR_HEAD)],
      reviews: [approval(1, users.carlos)],
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toBe("missing_current_head_observation");
  });

  it("round-trips valid observations and rejects malformed ledger comments (#6222)", () => {
    const value = observation([contributor(users.apurv, ["coauthor", "push_actor"])]);

    expect(parseObservationComment(renderObservationComment(value))).toEqual(value);
    expect(
      parseObservationComment('<!-- nemoclaw-independent-approval-ledger:v1\n{"version":2}\n-->'),
    ).toBeNull();
  });
});
