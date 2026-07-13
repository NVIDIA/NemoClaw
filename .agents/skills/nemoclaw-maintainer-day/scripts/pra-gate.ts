// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure PR Review Advisor gate logic — no shell calls, fully unit-testable.
 *
 * Exported and used by check-gates.ts. Separated so tests can exercise the
 * parsing and provenance validation without mocking `gh`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PraComment {
  id: number;
  user?: { login?: string };
  body?: string;
  updated_at?: string;
}

export interface PraRun {
  name?: string;
  path?: string | null;
  head_sha?: string;
  event?: string;
  run_attempt?: number;
  run_started_at?: string;
  created_at?: string;
  updated_at?: string;
  pull_requests?: Array<{
    number?: number;
    head?: { sha?: string | null } | null;
    base?: { sha?: string | null } | null;
  }> | null;
}

export interface PraMeta {
  headSha: string;
  recommendation: string;
  runId: number;
  runAttempt: number;
  commentId: number;
  event?: string;
  prNumber?: number;
  workflowSha?: string;
  baseSha?: string;
  workflowPath?: string;
}

export interface PrAdvisorGateResult {
  pass: boolean;
  details: string;
  recommendation?: string;
  openRequired?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Explicit allowlist: only these recommendation values mean "OK to merge".
// Anything else — including unknown values — fails the gate.
// Source: SUMMARY_RECOMMENDATIONS in tools/pr-review-advisor/analyze.mts.
// "approved" is not a valid advisor recommendation; only "merge_as_is" is.
export const PRA_PASS_RECOMMENDATIONS = new Set(["merge_as_is"]);

const PRA_WORKFLOW_NAME = "PR Review / Advisor";
const PRA_WORKFLOW_PATH = ".github/workflows/pr-review-advisor.yaml";

// Full metadata line: all five fields must be present for a trusted comment.
const PRA_FULL_META_RE =
  /head_sha:\s*([0-9a-f]+);\s*recommendation:\s*([a-z_]+);\s*run_id:\s*(\d+);\s*run_attempt:\s*(\d+);\s*comment_id:\s*(\d+)(?:;\s*event:\s*([a-z_]+);\s*pr_number:\s*(\d+);\s*workflow_sha:\s*([0-9a-f]+);\s*base_sha:\s*([0-9a-f]+);\s*workflow_path:\s*([^\s;>]+))?/i;

const PRA_REQUIRED_RE = /\*\*Open items:\*\*[^|]*?(\d+)\s+required/;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Parse the embedded HTML metadata from a PRA comment body.
 * Returns null when metadata is absent or any required field is missing.
 */
export function parsePraMeta(body: string): PraMeta | null {
  const m = PRA_FULL_META_RE.exec(body);
  if (!m) return null;
  return {
    headSha: m[1].toLowerCase(),
    recommendation: m[2].toLowerCase(),
    runId: parseInt(m[3], 10),
    runAttempt: parseInt(m[4], 10),
    commentId: parseInt(m[5], 10),
    event: m[6]?.toLowerCase(),
    prNumber: m[7] === undefined ? undefined : parseInt(m[7], 10),
    workflowSha: m[8]?.toLowerCase(),
    baseSha: m[9]?.toLowerCase(),
    workflowPath: m[10],
  };
}

/**
 * Evaluate a single PRA comment against the current PR head SHA.
 * Validates provenance (comment_id and head_sha) before trusting the
 * recommendation so a spoofed or stale comment cannot bypass the gate.
 */
export function evalPraComment(comment: PraComment, headSha: string): PrAdvisorGateResult {
  const body = comment.body ?? "";
  const meta = parsePraMeta(body);

  if (!meta) {
    return {
      pass: false,
      details: "PR Review Advisor marker present but metadata incomplete — fail-closed",
    };
  }

  if (meta.commentId !== comment.id) {
    return {
      pass: false,
      details: "PR Review Advisor comment_id mismatch — fail-closed (possible spoof)",
    };
  }

  const normalizedHead = headSha.toLowerCase();
  if (meta.headSha !== normalizedHead) {
    return {
      pass: false,
      details: `PR Review Advisor is stale (sha ${meta.headSha.slice(0, 7)} ≠ head ${normalizedHead.slice(0, 7)}) — re-run CI`,
    };
  }

  const rec = meta.recommendation;
  if (PRA_PASS_RECOMMENDATIONS.has(rec)) {
    return { pass: true, details: `PR Review Advisor: ${rec}`, recommendation: rec };
  }

  const requiredMatch = PRA_REQUIRED_RE.exec(body);
  const openRequired = requiredMatch ? parseInt(requiredMatch[1], 10) : undefined;

  return {
    pass: false,
    details: `PR Review Advisor: ${rec}${openRequired !== undefined ? ` (${openRequired} required item(s))` : ""}`,
    recommendation: rec,
    openRequired,
  };
}

/**
 * Parse NDJSON output from `gh api --paginate --jq ".[]"`.
 * Each line is one JSON comment object; malformed lines are skipped.
 */
export function parsePraCommentNdjson(raw: string): PraComment[] {
  const comments: PraComment[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      comments.push(JSON.parse(trimmed) as PraComment);
    } catch {
      // skip malformed lines
    }
  }
  return comments;
}

/**
 * Return the latest github-actions[bot] comment that contains the PRA marker.
 * Only github-actions[bot] is trusted; user-posted comments are ignored.
 */
export function selectLatestTrustedPraComment(comments: PraComment[]): PraComment | null {
  const trusted = comments.filter(
    (c) =>
      c.user?.login === "github-actions[bot]" &&
      (c.body ?? "").includes("nemoclaw-pr-review-advisor"),
  );
  return trusted.length > 0 ? trusted[trusted.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Run provenance
// ---------------------------------------------------------------------------

function isTimestampWithin(value: string, start: string, end: string): boolean {
  const t = Date.parse(value);
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (![t, s, e].every(Number.isFinite)) return false;
  return t >= s && t <= e;
}

function normalizeWorkflowPath(value: string): string {
  return value.split("@", 1)[0];
}

/**
 * Verify that a GitHub Actions run corresponds to the trusted PR Review / Advisor
 * workflow for this PR head.
 *
 * The pull_request branch preserves the original rollout contract: the run
 * head_sha is the PR head. A pull_request_target run instead executes at a
 * trusted base ref, so its PR identity and head SHA must come from exactly one
 * run.pull_requests association. GitHub may return the workflow path with an
 * @ref suffix; only the path portion identifies the workflow file.
 *
 * Pure function — the caller is responsible for fetching the run data.
 */
export function validateAdvisorRun(
  run: PraRun,
  meta: PraMeta,
  commentUpdatedAt: string,
  prNumber: number,
  baseSha?: string,
): boolean {
  const startedAt = run.run_started_at ?? run.created_at;
  const endedAt = run.updated_at;
  if (!startedAt || !endedAt) return false;

  if (
    run.name !== PRA_WORKFLOW_NAME ||
    (run.run_attempt ?? -1) !== meta.runAttempt ||
    !isTimestampWithin(commentUpdatedAt, startedAt, endedAt)
  ) {
    return false;
  }

  if (run.event === "pull_request") {
    return (
      (meta.event === undefined || meta.event === "pull_request") &&
      (run.head_sha ?? "").toLowerCase() === meta.headSha
    );
  }

  if (run.event !== "pull_request_target") return false;

  if (typeof run.path !== "string" || normalizeWorkflowPath(run.path) !== PRA_WORKFLOW_PATH) {
    return false;
  }

  if (
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    meta.event !== "pull_request_target" ||
    meta.prNumber !== prNumber ||
    !meta.workflowSha ||
    meta.workflowSha !== (run.head_sha ?? "").toLowerCase() ||
    !meta.baseSha ||
    meta.baseSha !== (baseSha ?? "").toLowerCase() ||
    !meta.workflowPath ||
    normalizeWorkflowPath(meta.workflowPath) !== PRA_WORKFLOW_PATH ||
    !Array.isArray(run.pull_requests) ||
    run.pull_requests.length !== 1
  ) {
    return false;
  }

  const association = run.pull_requests[0];
  return (
    association.number === prNumber &&
    (association.head?.sha ?? "").toLowerCase() === meta.headSha &&
    (association.base?.sha ?? "").toLowerCase() === meta.baseSha
  );
}
