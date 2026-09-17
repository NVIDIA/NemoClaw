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
        {
          id: 24,
          state: "CHANGES_REQUESTED",
          commit_id: "e".repeat(40),
          submitted_at: "2026-09-14T14:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer-d", type: "User" },
          body: "Blocker D was later cleared.",
        },
        {
          id: 25,
          state: "APPROVED",
          commit_id: "e".repeat(40),
          submitted_at: "2026-09-14T15:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer-d", type: "User" },
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
        {
          pull_request_review_id: 24,
          path: "src/d.ts",
          line: 40,
          body: "Recheck D.",
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
    expect(selected?.body).not.toContain("Blocker D was later cleared.");
    expect(selected?.inlineComments).not.toContainEqual(
      expect.objectContaining({ path: "src/d.ts" }),
    );
  });

  it("falls back to the latest trusted reviewer when the preferred reviewer has no review", () => {
    const selected = selectFollowUpReview(
      [
        {
          id: 30,
          state: "APPROVED",
          commit_id: "a".repeat(40),
          submitted_at: "2026-09-14T10:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer-b", type: "User" },
          body: "Trusted review from another maintainer.",
        },
      ],
      [],
      "f".repeat(40),
      "maintainer-a",
    );

    expect(selected).toMatchObject({
      reviewId: 30,
      reviewer: "maintainer-b",
      state: "APPROVED",
    });
  });

  it("retains a bounded excerpt from every unresolved review body", () => {
    const selected = selectFollowUpReview(
      ["A", "B", "C"].map((marker, index) => ({
        id: 40 + index,
        state: "CHANGES_REQUESTED",
        commit_id: marker.toLowerCase().repeat(40),
        submitted_at: `2026-09-14T1${index}:00:00Z`,
        author_association: "MEMBER",
        user: { login: `maintainer-${marker.toLowerCase()}`, type: "User" },
        body: marker.repeat(20_000),
      })),
      [],
      "f".repeat(40),
    );

    expect(selected?.body).toHaveLength(20_000);
    expect(selected?.body).toContain("Review 40 by maintainer-a");
    expect(selected?.body).toContain("A".repeat(100));
    expect(selected?.body).toContain("Review 41 by maintainer-b");
    expect(selected?.body).toContain("B".repeat(100));
    expect(selected?.body).toContain("Review 42 by maintainer-c");
    expect(selected?.body).toContain("C".repeat(100));
  });
});
