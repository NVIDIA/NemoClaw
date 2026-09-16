// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubGraphql, upsertStickyComment } from "../../../tools/advisors/github.mts";
import {
  classifyTestDepth,
  collectStaticTestInventory,
} from "../../../tools/pr-review-advisor/deterministic-context.mts";
import {
  collectGitHubReviewContext,
  declaresReplacement,
  extractIssueRefs,
  hasOpenPrReplacement,
  type OpenPrOverlap,
  writeGitHubReviewContext,
} from "../../../tools/pr-review-advisor/github-context.mts";
import { buildSystemPrompt } from "../../../tools/pr-review-advisor/trusted-guidance.mts";
const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("PR review advisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires an explicit replacement relation for superseded recommendations", () => {
    const overlap = (overrides: Partial<OpenPrOverlap>): OpenPrOverlap => ({
      number: 7654,
      title: "Concurrent change",
      labels: [],
      linkedIssues: [123],
      linkedIssueCount: 1,
      sameFiles: ["src/lib/example.ts"],
      sameFileCount: 1,
      duplicateLinkedIssues: [123],
      replacesCurrentPr: false,
      ...overrides,
    });

    expect(declaresReplacement("Refs #123 and shares files", 7542)).toBe(false);
    expect(declaresReplacement("Replaces PR #7542", 7542)).toBe(true);
    expect(hasOpenPrReplacement([overlap({})])).toBe(false);
    expect(hasOpenPrReplacement([overlap({ replacesCurrentPr: true })])).toBe(true);
  });

  it("surfaces GitHub GraphQL errors even when the HTTP status is successful", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: null }, errors: [{ message: "rate limit" }] }),
    } as Response);

    await expect(githubGraphql("token", "query { viewer { login } }", {})).rejects.toThrow(
      "GitHub GraphQL returned errors: rate limit",
    );
  });

  it("paginates the complete review history and only the selected review comments", async () => {
    const currentHead = "c".repeat(40);
    const requests: string[] = [];
    const olderReviews = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      state: "CHANGES_REQUESTED",
      commit_id: "a".repeat(40),
      submitted_at: `2026-09-14T10:${String(index % 60).padStart(2, "0")}:00Z`,
      author_association: "MEMBER",
      user: { login: "maintainer", type: "User" },
      body: `Older review ${index + 1}`,
    }));
    const selectedReview = {
      id: 101,
      state: "CHANGES_REQUESTED",
      commit_id: "b".repeat(40),
      submitted_at: "2026-09-15T10:00:00Z",
      author_association: "MEMBER",
      user: { login: "maintainer", type: "User" },
      body: "Newest frozen contract",
    };
    const firstCommentPage = Array.from({ length: 100 }, (_, index) => ({
      pull_request_review_id: 101,
      path: `src/file-${index}.ts`,
      line: index + 1,
      body: `Comment ${index + 1}`,
    }));
    const finalComment = {
      pull_request_review_id: 101,
      path: "src/final.ts",
      line: 101,
      body: "Final comment",
    };
    const responses = new Map<string, unknown>([
      [
        "/repos/NVIDIA/NemoClaw/pulls/7542?page=",
        {
          number: 7542,
          title: "Follow-up review",
          body: "",
          head: { ref: "feature", sha: currentHead },
          base: { ref: "main", sha: "d".repeat(40) },
        },
      ],
      ["/repos/NVIDIA/NemoClaw/pulls/7542/reviews?page=1", olderReviews],
      ["/repos/NVIDIA/NemoClaw/pulls/7542/reviews?page=2", [selectedReview]],
      ["/repos/NVIDIA/NemoClaw/pulls/7542/reviews/101/comments?page=1", firstCommentPage],
      ["/repos/NVIDIA/NemoClaw/pulls/7542/reviews/101/comments?page=2", [finalComment]],
    ]);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const requestUrl = String(input);
      requests.push(requestUrl);
      const url = new URL(requestUrl);
      const responseKey = `${url.pathname}?page=${url.searchParams.get("page") ?? ""}`;
      return { ok: true, json: async () => responses.get(responseKey) ?? [] } as Response;
    });

    const context = await collectGitHubReviewContext({
      GH_TOKEN: "host-token",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      PR_NUMBER: "7542",
      PR_REVIEW_ADVISOR_REVIEWER_LOGIN: "maintainer",
    });

    expect(context?.followUpReview).toMatchObject({
      reviewId: 101,
      reviewedHeadSha: "b".repeat(40),
      body: "Newest frozen contract",
    });
    expect(context?.followUpReview?.inlineComments).toHaveLength(101);
    expect(context?.followUpReview?.inlineComments.at(-1)).toEqual({
      path: "src/final.ts",
      line: 101,
      body: "Final comment",
    });
    expect(requests.some((url) => url.includes("/reviews?per_page=100&page=2"))).toBe(true);
    expect(requests.some((url) => url.includes("/reviews/101/comments?per_page=100&page=2"))).toBe(
      true,
    );
    expect(requests.some((url) => /pulls\/7542\/comments/u.test(url))).toBe(false);
  });

  it("cancels a delayed pagination request at the shared context deadline", async () => {
    const currentHead = "c".repeat(40);
    let delayedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("page");
      const kind = url.pathname.endsWith("/pulls/7542")
        ? "pull"
        : url.pathname.endsWith("/pulls/7542/reviews") && page === "1"
          ? "reviews-1"
          : url.pathname.endsWith("/pulls/7542/reviews") && page === "2"
            ? "reviews-2"
            : "other";
      delayedSignal = kind === "reviews-2" ? (init?.signal ?? undefined) : delayedSignal;
      return kind === "pull"
        ? ({
            ok: true,
            json: async () => ({
              number: 7542,
              title: "Deadline",
              body: "",
              head: { ref: "feature", sha: currentHead },
              base: { ref: "main", sha: "d".repeat(40) },
            }),
          } as Response)
        : kind === "reviews-1"
          ? ({
              ok: true,
              json: async () => Array.from({ length: 100 }, () => ({})),
            } as Response)
          : kind === "reviews-2"
            ? await new Promise<Response>((_resolve, reject) => {
                delayedSignal?.addEventListener("abort", () => reject(delayedSignal?.reason), {
                  once: true,
                });
              })
            : ({ ok: true, json: async () => [] } as Response);
    });

    const context = await collectGitHubReviewContext(
      {
        GH_TOKEN: "host-token",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        PR_NUMBER: "7542",
      },
      { signal: AbortSignal.timeout(20) },
    );

    expect(delayedSignal?.aborted).toBe(true);
    expect(context?.fetchError).toContain("timed out before every required page was fetched");
  });

  it("does not write a hosted context artifact after a GitHub API failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "upstream unavailable",
    } as Response);
    const directory = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-advisor-context-"));
    const output = path.join(directory, "github-context.json");
    try {
      await expect(
        writeGitHubReviewContext(
          {
            GH_TOKEN: "host-token",
            GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
            PR_NUMBER: "7542",
          },
          output,
        ),
      ).rejects.toThrow("GitHub review context is incomplete");
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not fall back when the trusted security rubric is unavailable", () => {
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("missing rubric fixture");
    });

    expect(() => buildSystemPrompt()).toThrow("Security rubric unavailable");
  });

  it("collects static test inventory from changed test files", () => {
    const inventory = collectStaticTestInventory([
      "test/automation/pull-requests/pr-review-advisor-context.test.ts",
    ]);

    expect(inventory.changedTestFiles).toContain(
      "test/automation/pull-requests/pr-review-advisor-context.test.ts",
    );
    expect(inventory.nearbyTestNames.some((name) => name.includes("PR review advisor"))).toBe(true);
    expect(inventory.candidateExistingCoverage.join("\n")).toContain("named test block");
  });

  it("requires test ownership evidence before recommending more coverage", () => {
    const prompt = buildSystemPrompt();

    expect(
      [
        "testDepth.suggestedTests and staticTestInventory are internal starting points for selecting existing validation, not proof that coverage is absent or authorization to add or modify tests.",
        "Prefer, in order: cite existing coverage unchanged; extend an existing owner with one missing case; add a new test only when no existing owner can express the behavior; or state why automated coverage does not apply.",
        "A changed source file without a changed test file does not establish a gap.",
        "Review every invariant listed in riskPlan against the diff and checked-in test evidence under the general regression-evidence rule above. After applying that rule, report a finding when a changed invariant lacks applicable checked-in regression evidence, unless a more specific finding already covers the same gap.",
        "Selecting an existing E2E selector identifies applicable validation; only its revision-bound result can validate the PR. It does not authorize adding or modifying E2E tests, assertions, fixtures, selectors, matrix entries, jobs, or workflow fan-out.",
        "Propose a new live E2E test only when the changed behavior crosses a real external boundary that no existing live proof reaches.",
        "If a real boundary gap is outside the accepted scope of the current PR, record it as a limitation instead of asking this PR to add coverage.",
        "missingRegressionTest with exactly one decision",
      ].filter((clause) => !prompt.includes(clause)),
    ).toEqual([]);
  });

  it("keeps heuristic test-depth outputs factual while the prompt owns coverage decisions", () => {
    const runtimeBoundaryDiff = `diff --git a/src/lib/example.ts b/src/lib/example.ts
+++ b/src/lib/example.ts
+spawn("command");`;
    const requiredRiskCandidates = classifyTestDepth([
      "agents/langchain-deepagents-code/patch-managed-deepagents-code.py",
    ]).suggestedTests;

    expect({
      testOrDocs: classifyTestDepth(["test/example.test.ts"]).suggestedTests,
      requiredRiskUsesFactualJobAndTarget:
        requiredRiskCandidates.some((candidate) =>
          candidate.includes("E2E job validation candidate"),
        ) &&
        requiredRiskCandidates.some((candidate) =>
          candidate.includes("typed E2E target validation candidate"),
        ) &&
        requiredRiskCandidates.every(
          (candidate) =>
            candidate.startsWith("Existing ") && !/\b(?:add|modify|run)\b/i.test(candidate),
        ),
      runtimePath: classifyTestDepth(["src/lib/example-sandbox.ts"]).suggestedTests,
      runtimeBoundary: classifyTestDepth(["src/lib/example.ts"], undefined, runtimeBoundaryDiff)
        .suggestedTests,
      mockedBoundary: classifyTestDepth(["src/lib/example-provider.ts"]).suggestedTests,
      unchangedTests: collectStaticTestInventory(["tools/pr-review-advisor/context-tests.mts"])
        .candidateExistingCoverage,
      defaultUnit: classifyTestDepth(["src/lib/example.ts"]).suggestedTests,
    }).toEqual({
      testOrDocs: ["Unit or documentation validation candidate for the touched files."],
      requiredRiskUsesFactualJobAndTarget: true,
      runtimePath: [
        "Runtime or integration validation candidate for the changed behavior; external E2E job results are outside this context.",
      ],
      runtimeBoundary: [
        "Integration validation candidate for the changed process or container behavior.",
      ],
      mockedBoundary: [
        "Behavioral validation candidate with mocked filesystem, network, or process boundaries.",
      ],
      unchangedTests: [
        "No changed test files were detected for changed source files: tools/pr-review-advisor/context-tests.mts.",
      ],
      defaultUnit: ["Targeted unit validation candidate for the changed modules."],
    });
  });

  it("recognizes issue relations used by the PR template and common PR prose (#6446)", () => {
    expect(
      extractIssueRefs(
        "Follow-up to #6446\nFollow up #21\nfollowup to #22\nFollow-up to #6547\nRefs #6258\nReferences #6194",
        6547,
      ),
    ).toEqual([21, 22, 6194, 6258, 6446]);
  });

  it.each([
    ["conjunction", "Follow-up to #6547 and #6446.", [6446, 6547]],
    ["comma-separated list", "Refs #1, #2 and #3.", [1, 2, 3]],
    ["Oxford-comma list", "References #4, #5, and #6.", [4, 5, 6]],
  ] as const)("recognizes every issue in a %s relation (#6446)", (_case, text, expected) => {
    expect(extractIssueRefs(text, 6566)).toEqual(expected);
  });

  it("skips symlinked changed test files in static test inventory", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-symlink-"));
    const outside = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-advisor-outside-"));
    const outsideFile = path.join(outside, "secret.test.ts");
    const linkPath = path.join(tmp, "linked.test.ts");
    fs.writeFileSync(outsideFile, 'describe("secret outside test", () => {});\n');
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }

    try {
      const changedPath = path.relative(ROOT, linkPath);
      const inventory = collectStaticTestInventory([changedPath]);

      expect(inventory.nearbyTestNames.join("\n")).not.toContain("secret outside test");
      expect(inventory.candidateExistingCoverage.join("\n")).toContain(
        "not a regular in-repository file",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("upserts sticky comments with created comment-scoped bodies", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, text: async () => "[]" } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => '{"id":123}' } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" } as Response);

    await upsertStickyComment({
      repo: "NVIDIA/NemoClaw",
      pr: "1",
      token: "token",
      marker: "<!-- marker -->",
      body: "<!-- marker --> pending",
      label: "test",
      bodyForComment: (comment) => `<!-- marker --> comment_id=${comment.id}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("issues/comments/123");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      body: "<!-- marker --> comment_id=123",
    });
  });

  it("upserts sticky comments with existing comment-scoped bodies", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          '[{"id":7,"body":"<!-- marker --> old","user":{"login":"github-actions[bot]"}}]',
      } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" } as Response);

    await upsertStickyComment({
      repo: "NVIDIA/NemoClaw",
      pr: "1",
      token: "token",
      marker: "<!-- marker -->",
      body: "<!-- marker --> pending",
      label: "test",
      bodyForComment: (comment) => `<!-- marker --> comment_id=${comment.id}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("issues/comments/7");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      body: "<!-- marker --> comment_id=7",
    });
  });
});
