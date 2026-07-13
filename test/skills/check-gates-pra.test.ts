// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  evalPraComment,
  PRA_PASS_RECOMMENDATIONS,
  type PraMeta,
  type PraRun,
  parsePraCommentNdjson,
  parsePraMeta,
  selectLatestTrustedPraComment,
  validateAdvisorRun,
} from "../../.agents/skills/nemoclaw-maintainer-day/scripts/pra-gate.ts";

const HEAD = "8e012dc98c3c4bd53d64ac4f072d4a9f23729db0";
const BASE = "a".repeat(40);

function makeBody(
  overrides: Partial<{
    headSha: string;
    recommendation: string;
    commentId: number;
    targetMetadata: string;
  }>,
): string {
  const headSha = overrides.headSha ?? HEAD;
  const recommendation = overrides.recommendation ?? "blocked";
  const commentId = overrides.commentId ?? 42;
  return [
    "<!-- nemoclaw-pr-review-advisor -->",
    `<!-- head_sha: ${headSha}; recommendation: ${recommendation}; run_id: 1; run_attempt: 1; comment_id: ${commentId}${overrides.targetMetadata ?? ""} -->`,
    "## PR Review Advisor",
    "**Open items:** 2 required · 1 warning",
  ].join("\n");
}

function makeComment(overrides: Partial<{ id: number; login: string; body: string }> = {}) {
  return {
    id: overrides.id ?? 42,
    user: { login: overrides.login ?? "github-actions[bot]" },
    body: overrides.body ?? makeBody({}),
  };
}

// ---------------------------------------------------------------------------
// parsePraMeta
// ---------------------------------------------------------------------------

describe("parsePraMeta", () => {
  it("parses all five fields from a well-formed body", () => {
    const body = makeBody({ headSha: HEAD, recommendation: "blocked", commentId: 99 });
    const meta = parsePraMeta(body);
    expect(meta).not.toBeNull();
    expect(meta?.headSha).toBe(HEAD.toLowerCase());
    expect(meta?.recommendation).toBe("blocked");
    expect(meta?.commentId).toBe(99);
  });

  it("returns null when metadata line is absent", () => {
    expect(parsePraMeta("<!-- nemoclaw-pr-review-advisor -->\nsome body text")).toBeNull();
  });

  it("returns null when any field is missing", () => {
    expect(parsePraMeta("<!-- head_sha: abc; recommendation: blocked -->")).toBeNull();
  });

  it("normalises headSha to lowercase", () => {
    const body = makeBody({ headSha: HEAD.toUpperCase() });
    expect(parsePraMeta(body)?.headSha).toBe(HEAD.toLowerCase());
  });

  it("parses target-event provenance after the legacy five fields", () => {
    const body = makeBody({
      targetMetadata: `; event: pull_request_target; pr_number: 6736; workflow_sha: ${"B".repeat(40)}; base_sha: ${BASE}; workflow_path: .github/workflows/pr-review-advisor.yaml@refs/heads/main`,
    });
    expect(parsePraMeta(body)).toMatchObject({
      event: "pull_request_target",
      prNumber: 6736,
      workflowSha: "b".repeat(40),
      baseSha: BASE,
      workflowPath: ".github/workflows/pr-review-advisor.yaml@refs/heads/main",
    });
  });
});

// ---------------------------------------------------------------------------
// parsePraCommentNdjson
// ---------------------------------------------------------------------------

describe("parsePraCommentNdjson", () => {
  it("parses multiple NDJSON lines", () => {
    const lines = [
      JSON.stringify({ id: 1, user: { login: "alice" }, body: "hello" }),
      JSON.stringify({ id: 2, user: { login: "bob" }, body: "world" }),
    ].join("\n");
    const comments = parsePraCommentNdjson(lines);
    expect(comments).toHaveLength(2);
    expect(comments[0].id).toBe(1);
    expect(comments[1].id).toBe(2);
  });

  it("skips blank lines and malformed JSON", () => {
    const raw = `${JSON.stringify({ id: 1 })}\n\nnot json\n${JSON.stringify({ id: 2 })}`;
    expect(parsePraCommentNdjson(raw)).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(parsePraCommentNdjson("")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectLatestTrustedPraComment
// ---------------------------------------------------------------------------

describe("selectLatestTrustedPraComment", () => {
  it("returns the last github-actions[bot] comment with the PRA marker", () => {
    const comments = [makeComment({ id: 1 }), makeComment({ id: 2 })];
    expect(selectLatestTrustedPraComment(comments)?.id).toBe(2);
  });

  it("ignores comments from non-bot users", () => {
    const comments = [
      makeComment({ id: 1, login: "alice" }),
      makeComment({ id: 2, login: "github-actions[bot]" }),
      makeComment({ id: 3, login: "malicious-user" }),
    ];
    expect(selectLatestTrustedPraComment(comments)?.id).toBe(2);
  });

  it("ignores bot comments without the PRA marker", () => {
    const comments = [
      { id: 1, user: { login: "github-actions[bot]" }, body: "some other bot comment" },
    ];
    expect(selectLatestTrustedPraComment(comments)).toBeNull();
  });

  it("returns null when no trusted comments exist", () => {
    expect(selectLatestTrustedPraComment([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evalPraComment — provenance checks
// ---------------------------------------------------------------------------

describe("evalPraComment — provenance", () => {
  it("fails closed when metadata is incomplete", () => {
    const comment = makeComment({ body: "<!-- nemoclaw-pr-review-advisor -->\nno metadata" });
    const result = evalPraComment(comment, HEAD);
    expect(result.pass).toBe(false);
    expect(result.details).toMatch(/incomplete/i);
  });

  it("fails closed when comment_id does not match actual comment id", () => {
    const comment = makeComment({ id: 99, body: makeBody({ commentId: 1 }) });
    const result = evalPraComment(comment, HEAD);
    expect(result.pass).toBe(false);
    expect(result.details).toMatch(/mismatch/i);
  });

  it("fails closed when head_sha is stale", () => {
    const staleHead = "a".repeat(40);
    const comment = makeComment({ body: makeBody({ headSha: staleHead }) });
    const result = evalPraComment(comment, HEAD);
    expect(result.pass).toBe(false);
    expect(result.details).toMatch(/stale/i);
  });
});

// ---------------------------------------------------------------------------
// evalPraComment — recommendation values
// ---------------------------------------------------------------------------

describe("evalPraComment — recommendations", () => {
  for (const rec of PRA_PASS_RECOMMENDATIONS) {
    it(`passes for recommendation="${rec}"`, () => {
      const comment = makeComment({ body: makeBody({ recommendation: rec }) });
      const result = evalPraComment(comment, HEAD);
      expect(result.pass).toBe(true);
      expect(result.recommendation).toBe(rec);
    });
  }

  it("fails for recommendation=blocked", () => {
    const comment = makeComment();
    const result = evalPraComment(comment, HEAD);
    expect(result.pass).toBe(false);
    expect(result.recommendation).toBe("blocked");
  });

  it("fails for recommendation=merge_after_fixes", () => {
    const comment = makeComment({ body: makeBody({ recommendation: "merge_after_fixes" }) });
    expect(evalPraComment(comment, HEAD).pass).toBe(false);
  });

  it("fails for recommendation=needs_rework", () => {
    const comment = makeComment({ body: makeBody({ recommendation: "needs_rework" }) });
    expect(evalPraComment(comment, HEAD).pass).toBe(false);
  });

  it("fails for unknown recommendation values", () => {
    const comment = makeComment({ body: makeBody({ recommendation: "some_future_state" }) });
    expect(evalPraComment(comment, HEAD).pass).toBe(false);
  });

  it("extracts openRequired from the Open items line", () => {
    const comment = makeComment();
    const result = evalPraComment(comment, HEAD);
    expect(result.openRequired).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validateAdvisorRun
// ---------------------------------------------------------------------------

const RUN_START = "2026-01-01T00:00:00Z";
const RUN_END = "2026-01-01T01:00:00Z";
const COMMENT_TIME = "2026-01-01T00:30:00Z";

function makeRun(overrides: Partial<PraRun> = {}): PraRun {
  return {
    name: "PR Review / Advisor",
    head_sha: HEAD,
    event: "pull_request",
    run_attempt: 1,
    run_started_at: RUN_START,
    updated_at: RUN_END,
    ...overrides,
  };
}

function makeTargetRun(overrides: Partial<PraRun> = {}): PraRun {
  return makeRun({
    path: ".github/workflows/pr-review-advisor.yaml@refs/heads/main",
    head_sha: "b".repeat(40),
    event: "pull_request_target",
    pull_requests: [{ number: 6736, head: { sha: HEAD }, base: { sha: BASE } }],
    ...overrides,
  });
}

function makeMeta(overrides: Partial<PraMeta> = {}): PraMeta {
  return {
    headSha: HEAD.toLowerCase(),
    recommendation: "blocked",
    runId: 1,
    runAttempt: 1,
    commentId: 42,
    ...overrides,
  };
}

function makeTargetMeta(overrides: Partial<PraMeta> = {}): PraMeta {
  return makeMeta({
    event: "pull_request_target",
    prNumber: 6736,
    workflowSha: "b".repeat(40),
    baseSha: BASE,
    workflowPath: ".github/workflows/pr-review-advisor.yaml@refs/heads/main",
    ...overrides,
  });
}

function validateTargetRun(
  run = makeTargetRun(),
  meta = makeTargetMeta(),
  prNumber = 6736,
  baseSha = BASE,
): boolean {
  return validateAdvisorRun(run, meta, COMMENT_TIME, prNumber, baseSha);
}

describe("validateAdvisorRun", () => {
  it("preserves pull_request validation when all legacy fields match", () => {
    expect(validateAdvisorRun(makeRun(), makeMeta(), COMMENT_TIME, 6736)).toBe(true);
  });

  it("fails when run name is not PR Review / Advisor", () => {
    expect(
      validateAdvisorRun(makeRun({ name: "Other Workflow" }), makeMeta(), COMMENT_TIME, 6736),
    ).toBe(false);
  });

  it("fails when event is neither pull_request nor pull_request_target", () => {
    expect(validateAdvisorRun(makeRun({ event: "push" }), makeMeta(), COMMENT_TIME, 6736)).toBe(
      false,
    );
  });

  it("preserves pull_request rejection when run head_sha mismatches", () => {
    expect(
      validateAdvisorRun(makeRun({ head_sha: "b".repeat(40) }), makeMeta(), COMMENT_TIME, 6736),
    ).toBe(false);
  });

  it("fails when run_attempt mismatches", () => {
    expect(validateAdvisorRun(makeRun({ run_attempt: 2 }), makeMeta(), COMMENT_TIME, 6736)).toBe(
      false,
    );
  });

  it("fails when comment timestamp is before run start", () => {
    expect(validateAdvisorRun(makeRun(), makeMeta(), "2025-12-31T23:59:59Z", 6736)).toBe(false);
  });

  it("fails when comment timestamp is after run end", () => {
    expect(validateAdvisorRun(makeRun(), makeMeta(), "2026-01-01T02:00:00Z", 6736)).toBe(false);
  });

  it("fails when run_started_at and created_at are both absent", () => {
    const run = makeRun({ run_started_at: undefined, created_at: undefined });
    expect(validateAdvisorRun(run, makeMeta(), COMMENT_TIME, 6736)).toBe(false);
  });

  it("falls back to created_at when run_started_at is absent", () => {
    const run = makeRun({ run_started_at: undefined, created_at: RUN_START });
    expect(validateAdvisorRun(run, makeMeta(), COMMENT_TIME, 6736)).toBe(true);
  });

  it("rejects github-actions bot PRA metadata unless the run is PR Review Advisor for the same head and attempt", () => {
    // Simulates a different workflow posting a marker comment with valid comment_id and head_sha
    // but a non-Advisor workflow name — run validation must reject it.
    const spoofedRun = makeRun({ name: "CI / Build", event: "push" });
    expect(validateAdvisorRun(spoofedRun, makeMeta(), COMMENT_TIME, 6736)).toBe(false);
  });

  it("accepts a pull_request_target run associated with the requested PR and head", () => {
    expect(validateTargetRun()).toBe(true);
  });

  it("rejects a target run when the API omits the workflow path", () => {
    expect(validateTargetRun(makeTargetRun({ path: undefined }))).toBe(false);
  });

  it("rejects a target run from a different workflow path", () => {
    expect(
      validateTargetRun(
        makeTargetRun({ path: ".github/workflows/other-advisor.yaml@refs/heads/main" }),
      ),
    ).toBe(false);
  });

  it("rejects a target run whose path only has the trusted filename as a prefix", () => {
    expect(
      validateTargetRun(
        makeTargetRun({ path: ".github/workflows/pr-review-advisor.yaml.evil@refs/heads/main" }),
      ),
    ).toBe(false);
  });

  it("rejects a target run when pull_requests is absent", () => {
    expect(validateTargetRun(makeTargetRun({ pull_requests: undefined }))).toBe(false);
  });

  it("rejects a target run when no PR association is present", () => {
    expect(validateTargetRun(makeTargetRun({ pull_requests: [] }))).toBe(false);
  });

  it("rejects a target run when PR association is ambiguous", () => {
    expect(
      validateTargetRun(
        makeTargetRun({
          pull_requests: [
            { number: 6736, head: { sha: HEAD }, base: { sha: BASE } },
            { number: 6736, head: { sha: HEAD }, base: { sha: BASE } },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a target run associated with a different PR number", () => {
    expect(validateTargetRun(makeTargetRun(), makeTargetMeta(), 6737)).toBe(false);
  });

  it("rejects a target run associated with a different PR head", () => {
    expect(
      validateTargetRun(
        makeTargetRun({
          pull_requests: [{ number: 6736, head: { sha: "c".repeat(40) }, base: { sha: BASE } }],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a target run whose PR association omits the head SHA", () => {
    expect(
      validateTargetRun(
        makeTargetRun({ pull_requests: [{ number: 6736, head: null, base: { sha: BASE } }] }),
      ),
    ).toBe(false);
  });

  it("rejects a target run when the current PR base differs", () => {
    expect(validateTargetRun(makeTargetRun(), makeTargetMeta(), 6736, "c".repeat(40))).toBe(false);
  });

  it("rejects a target run when metadata names a different base", () => {
    expect(validateTargetRun(makeTargetRun(), makeTargetMeta({ baseSha: "c".repeat(40) }))).toBe(
      false,
    );
  });

  it("rejects a target run when its PR association omits the base SHA", () => {
    expect(
      validateTargetRun(
        makeTargetRun({ pull_requests: [{ number: 6736, head: { sha: HEAD }, base: null }] }),
      ),
    ).toBe(false);
  });

  it("rejects a target run when its PR association names a different base", () => {
    expect(
      validateTargetRun(
        makeTargetRun({
          pull_requests: [{ number: 6736, head: { sha: HEAD }, base: { sha: "c".repeat(40) } }],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a target run when target-event metadata is absent", () => {
    expect(validateTargetRun(makeTargetRun(), makeMeta())).toBe(false);
  });

  it("rejects a target run when metadata names a different event", () => {
    expect(validateTargetRun(makeTargetRun(), makeTargetMeta({ event: "pull_request" }))).toBe(
      false,
    );
  });

  it("rejects a target run when metadata names a different PR", () => {
    expect(validateTargetRun(makeTargetRun(), makeTargetMeta({ prNumber: 6737 }))).toBe(false);
  });

  it("rejects a target run when metadata workflow SHA differs from the run", () => {
    expect(
      validateTargetRun(makeTargetRun(), makeTargetMeta({ workflowSha: "c".repeat(40) })),
    ).toBe(false);
  });

  it("rejects a target run when metadata names a different workflow path", () => {
    expect(
      validateTargetRun(
        makeTargetRun(),
        makeTargetMeta({ workflowPath: ".github/workflows/other-advisor.yaml@refs/heads/main" }),
      ),
    ).toBe(false);
  });
});
