// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { selectFollowUpReview } from "../../../tools/pr-review-advisor/github-context.mts";

describe("PR Review Advisor follow-up contracts", () => {
  it("preserves successive unresolved reviews across maintainers in the frozen contract", () => {
    const selected = selectFollowUpReview(
      [
        {
          id: 20,
          state: "CHANGES_REQUESTED",
          commit_id: "a".repeat(40),
          submitted_at: "2026-09-14T10:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer-a", type: "User" },
          body: "Blocker A remains unresolved.",
        },
        {
          id: 21,
          state: "CHANGES_REQUESTED",
          commit_id: "b".repeat(40),
          submitted_at: "2026-09-14T11:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer-a", type: "User" },
          body: "Blocker B was introduced later.",
        },
        {
          id: 22,
          state: "APPROVED",
          commit_id: "c".repeat(40),
          submitted_at: "2026-09-14T12:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer-b", type: "User" },
        },
        {
          id: 23,
          state: "CHANGES_REQUESTED",
          commit_id: "d".repeat(40),
          submitted_at: "2026-09-14T13:00:00Z",
          author_association: "COLLABORATOR",
          user: { login: "maintainer-c", type: "User" },
          body: "Blocker C is independently unresolved.",
        },
      ],
      [
        {
          pull_request_review_id: 20,
          path: "src/a.ts",
          line: 10,
          body: "Recheck A.",
        },
        {
          pull_request_review_id: 21,
          path: "src/b.ts",
          line: 20,
          body: "Recheck B.",
        },
        {
          pull_request_review_id: 23,
          path: "src/c.ts",
          line: 30,
          body: "Recheck C.",
        },
      ],
      "f".repeat(40),
      "maintainer-a",
    );

    expect(selected).toMatchObject({
      reviewId: 23,
      reviewedHeadSha: "a".repeat(40),
      state: "CHANGES_REQUESTED",
      reviewer: "maintainer-a, maintainer-c",
      inlineComments: [
        { path: "src/a.ts", line: 10, body: "Recheck A." },
        { path: "src/b.ts", line: 20, body: "Recheck B." },
        { path: "src/c.ts", line: 30, body: "Recheck C." },
      ],
    });
    expect(selected?.body).toContain("Blocker A remains unresolved.");
    expect(selected?.body).toContain("Blocker B was introduced later.");
    expect(selected?.body).toContain("Blocker C is independently unresolved.");
  });
});
