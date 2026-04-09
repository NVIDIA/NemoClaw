// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic NemoClaw maintainer triage queue builder.
 *
 * Lists open PRs via gh, classifies them as merge-ready / near-miss / blocked,
 * enriches top candidates with file-level risky-area detection, applies
 * scoring weights, filters exclusions from the state file, and outputs
 * a ranked JSON queue.
 *
 * Usage: node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/triage.ts [--limit N] [--approved-only]
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isRiskyFile,
  run,
  parseStringArg,
  parseIntArg,
  SCORE_MERGE_NOW,
  SCORE_REVIEW_READY,
  SCORE_NEAR_MISS,
  SCORE_SECURITY_ACTIONABLE,
  SCORE_LABEL_SECURITY,
  SCORE_LABEL_PRIORITY_HIGH,
  SCORE_STALE_AGE,
  PENALTY_DRAFT_OR_CONFLICT,
  PENALTY_CODERABBIT_MAJOR,
  PENALTY_BROAD_CI_RED,
  PENALTY_MERGE_BLOCKED,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PrData {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergeStateStatus: string;
  reviewDecision: string;
  labels: Array<{ name: string }>;
  statusCheckRollup: Array<{
    name: string;
    status: string;
    conclusion: string;
  }>;
}

interface ClassifiedPr {
  number: number;
  title: string;
  url: string;
  author: string;
  churn: number;
  changedFiles: number;
  checksGreen: boolean;
  coderabbitMajor: boolean;
  reasons: string[];
  mergeNow: boolean;
  reviewReady: boolean;
  nearMiss: boolean;
  updatedAt: string;
  createdAt: string;
  draft: boolean;
  labels: string[];
}

interface QueueItem {
  rank: number;
  number: number;
  url: string;
  title: string;
  author: string;
  score: number;
  bucket: "merge-now" | "review-ready" | "salvage-now" | "blocked";
  reasons: string[];
  riskyFiles: string[];
  churn: number;
  changedFiles: number;
  nextAction: string;
  ageHours: number;
  labels: string[];
}

interface HotCluster {
  path: string;
  openPrCount: number;
}

interface TriageOutput {
  generatedAt: string;
  repo: string;
  scanned: number;
  queue: QueueItem[];
  nearMisses: QueueItem[];
  hotClusters: HotCluster[];
}

interface StateFile {
  excluded: {
    prs: Record<string, { reason: string; excludedAt: string }>;
    issues: Record<string, { reason: string; excludedAt: string }>;
  };
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function ghApi(path: string): unknown {
  const out = run("gh", ["api", path]);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

function fetchOpenPrs(repo: string, approvedOnly: boolean): PrData[] {
  // Use gh api --paginate with REST for lightweight pagination (no GraphQL timeout).
  // --jq outputs one JSON object per PR per page; we collect them as NDJSON then parse.
  const out = run("gh", [
    "api", "--paginate",
    `repos/${repo}/pulls?state=open&per_page=100`,
    "--jq", `.[] | {
      number, title, url: .html_url,
      author: {login: .user.login},
      additions: 0, deletions: 0, changedFiles: 0,
      isDraft: .draft,
      createdAt: .created_at, updatedAt: .updated_at,
      mergeStateStatus: (if .mergeable_state == "dirty" then "DIRTY"
        elif .mergeable_state == "clean" then "CLEAN"
        elif .mergeable_state == "blocked" then "BLOCKED"
        elif .mergeable_state == "unstable" then "UNSTABLE"
        else "UNKNOWN" end),
      reviewDecision: "",
      labels: [.labels[] | {name}],
      statusCheckRollup: []
    }`,
  ], 300_000);
  if (!out) return [];

  try {
    // Output is NDJSON (one JSON object per line)
    const prs: PrData[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && trimmed.startsWith("{")) {
        prs.push(JSON.parse(trimmed) as PrData);
      }
    }
    if (approvedOnly) {
      return prs.filter((pr) => pr.reviewDecision === "APPROVED");
    }
    return prs;
  } catch {
    return [];
  }
}

/**
 * Enrich a PR with review decision and CI status via GraphQL (per-PR).
 * Only call this for top candidates — it's one API call per PR.
 */
function enrichPr(repo: string, pr: PrData): void {
  const out = run("gh", [
    "pr", "view", String(pr.number), "--repo", repo,
    "--json", "reviewDecision,statusCheckRollup,additions,deletions,changedFiles",
  ]);
  if (!out) return;
  try {
    const data = JSON.parse(out) as {
      reviewDecision: string;
      statusCheckRollup: PrData["statusCheckRollup"];
      additions: number;
      deletions: number;
      changedFiles: number;
    };
    pr.reviewDecision = data.reviewDecision ?? "";
    pr.statusCheckRollup = data.statusCheckRollup ?? [];
    pr.additions = data.additions;
    pr.deletions = data.deletions;
    pr.changedFiles = data.changedFiles;
  } catch { /* leave as-is */ }
}

function classifyPr(pr: PrData): ClassifiedPr {
  const reasons: string[] = [];
  const draft = pr.isDraft;
  if (draft) reasons.push("draft");

  // Check CI status
  // gh returns two shapes: CheckRun {name, status, conclusion} and
  // StatusContext {context, state}. Handle both.
  const checks = pr.statusCheckRollup ?? [];
  const passingConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  let checksGreen = checks.length > 0;
  for (const check of checks) {
    const asAny = check as Record<string, string>;
    // StatusContext uses "state", CheckRun uses "conclusion"+"status"
    if (asAny.state) {
      // StatusContext: state is SUCCESS/FAILURE/PENDING/ERROR
      if (!passingConclusions.has(asAny.state.toUpperCase())) {
        checksGreen = false;
        break;
      }
    } else {
      // CheckRun: check conclusion after completion
      const conclusion = (asAny.conclusion ?? "").toUpperCase();
      const status = (asAny.status ?? "").toUpperCase();
      const done = status === "COMPLETED" || (!status && conclusion);
      if (!done || !passingConclusions.has(conclusion)) {
        checksGreen = false;
        break;
      }
    }
  }
  if (checks.length === 0) checksGreen = false;
  if (!checksGreen && !draft) reasons.push("failing-checks");

  // Check merge state
  // DIRTY = actual merge conflict. BLOCKED = branch protection (e.g. missing reviews).
  // CLEAN/HAS_HOOKS/UNSTABLE = mergeable. UNKNOWN = not yet computed.
  const mergeState = (pr.mergeStateStatus ?? "UNKNOWN").toUpperCase();
  const hasConflict = mergeState === "DIRTY";
  if (hasConflict) reasons.push("merge-conflict");

  // Check review decision
  const approved = pr.reviewDecision === "APPROVED";
  const blocked = mergeState === "BLOCKED";
  if (blocked && !hasConflict) reasons.push("merge-blocked");

  // Simple CodeRabbit heuristic: check labels for major findings
  // (Full CodeRabbit check is in check-gates.ts via GraphQL)
  const coderabbitMajor = false; // conservative — gate checker does the real check

  // Classify into buckets
  // merge-now: approved + green CI + no conflicts — ready for final gate
  const mergeNow = !draft && checksGreen && !hasConflict && approved && !coderabbitMajor;
  // review-ready: green CI + no conflicts + not draft — best candidates for review
  const reviewReady = !draft && !mergeNow && checksGreen && !hasConflict;
  // near-miss: not draft, has fixable blockers (failing CI or minor conflict)
  const nearMiss = !draft && !mergeNow && !reviewReady && reasons.length <= 2 &&
    !hasConflict;

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? "unknown",
    churn: pr.additions + pr.deletions,
    changedFiles: pr.changedFiles,
    checksGreen,
    coderabbitMajor,
    reasons,
    mergeNow,
    reviewReady,
    nearMiss,
    updatedAt: pr.updatedAt,
    createdAt: pr.createdAt,
    draft,
    labels: (pr.labels ?? []).map((l) => l.name),
  };
}

function fetchPrFiles(repo: string, number: number): string[] {
  const data = ghApi(`repos/${repo}/pulls/${number}/files?per_page=100`) as
    | Array<{ filename: string }>
    | null;
  if (!Array.isArray(data)) return [];
  return data.map((f) => f.filename);
}

function loadState(): StateFile | null {
  const stateDir = resolve(".nemoclaw-maintainer");
  const statePath = resolve(stateDir, "state.json");
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as StateFile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreItem(
  item: ClassifiedPr,
  riskyFiles: string[],
): { score: number; bucket: "merge-now" | "review-ready" | "salvage-now" | "blocked"; nextAction: string } {
  let score = 0;
  let bucket: "merge-now" | "review-ready" | "salvage-now" | "blocked" = "blocked";
  let nextAction = "review";

  if (item.mergeNow) {
    score += SCORE_MERGE_NOW;
    bucket = "merge-now";
    nextAction = "merge-gate";
  } else if (item.reviewReady) {
    score += SCORE_REVIEW_READY;
    bucket = "review-ready";
    nextAction = "review → merge-gate";
  } else if (item.nearMiss) {
    score += SCORE_NEAR_MISS;
    bucket = "salvage-now";
    nextAction = "salvage-pr";
  }

  if (riskyFiles.length > 0 && bucket !== "blocked") {
    score += SCORE_SECURITY_ACTIONABLE;
    nextAction = bucket === "merge-now" ? "security-sweep → merge-gate" : "security-sweep → review";
  }

  // GitHub label boosts
  const labelSet = new Set(item.labels.map((l) => l.toLowerCase()));
  if (labelSet.has("security")) score += SCORE_LABEL_SECURITY;
  if (labelSet.has("priority: high")) score += SCORE_LABEL_PRIORITY_HIGH;

  if (item.updatedAt) {
    const age = Date.now() - new Date(item.updatedAt).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) score += SCORE_STALE_AGE;
  }

  const reasons = new Set(item.reasons);
  if (item.draft) score += PENALTY_DRAFT_OR_CONFLICT;
  if (reasons.has("merge-conflict")) score += PENALTY_DRAFT_OR_CONFLICT;
  if (item.coderabbitMajor) score += PENALTY_CODERABBIT_MAJOR;
  if (reasons.has("failing-checks") && !item.nearMiss) score += PENALTY_BROAD_CI_RED;
  if (reasons.has("merge-blocked")) score += PENALTY_MERGE_BLOCKED;

  return { score, bucket, nextAction };
}

// ---------------------------------------------------------------------------
// Hotspot detection from PR file overlap
// ---------------------------------------------------------------------------

function detectHotClusters(
  items: ClassifiedPr[],
  repo: string,
  fileCache: Map<number, string[]>,
): HotCluster[] {
  const fileCounts = new Map<string, number>();

  for (const item of items.slice(0, 30)) {
    let files = fileCache.get(item.number);
    if (!files) {
      files = fetchPrFiles(repo, item.number);
      fileCache.set(item.number, files);
    }
    const seen = new Set<string>();
    for (const f of files) {
      if (!seen.has(f)) {
        seen.add(f);
        fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
      }
    }
  }

  return [...fileCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([path, count]) => ({ path, openPrCount: count }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const approvedOnly = args.includes("--approved-only");
  const limit = parseIntArg(args, "--limit", 10);
  const repo = parseStringArg(args, "--repo", "NVIDIA/NemoClaw");

  // 1. Fetch all open PRs via REST (lightweight, paginated, no GraphQL timeout)
  process.stderr.write("Fetching all open PRs via REST...\n");
  const prs = fetchOpenPrs(repo, false);
  if (prs.length === 0) {
    console.error("No open PRs found. GitHub API may be experiencing issues.");
    process.exit(1);
  }
  process.stderr.write(`Found ${prs.length} open PRs. Filtering non-draft candidates...\n`);

  // 2. Filter to non-draft, then enrich top candidates with CI + review data.
  // NOTE: Enrichment is capped at limit*3 by design — each enrichPr() call is
  // a separate GitHub API request, so we intentionally limit the blast radius.
  // Un-enriched PRs will classify as "blocked" (empty checks), which is the
  // safe default. This is NOT a bug.
  const candidates = prs.filter((pr) => !pr.isDraft);
  const enrichCount = Math.min(candidates.length, limit * 3);
  process.stderr.write(`Enriching ${enrichCount} of ${candidates.length} candidates...\n`);
  for (let i = 0; i < enrichCount; i++) {
    enrichPr(repo, candidates[i]);
  }

  // 3. Classify all PRs (un-enriched ones will be blocked due to empty checks)
  const classified = prs.map(classifyPr);
  process.stderr.write(
    `Classified: ${classified.filter((c) => c.mergeNow).length} merge-now, ` +
    `${classified.filter((c) => c.reviewReady).length} review-ready, ` +
    `${classified.filter((c) => c.nearMiss).length} near-miss, ` +
    `${classified.filter((c) => !c.mergeNow && !c.reviewReady && !c.nearMiss).length} blocked\n`,
  );

  // 2. Load exclusions
  const state = loadState();
  const excludedPrs = new Set(
    Object.keys(state?.excluded?.prs ?? {}).map(Number),
  );

  const allItems = classified.filter((item) => !excludedPrs.has(item.number));

  // 3. Enrich top candidates with file data and scoring
  const fileCache = new Map<number, string[]>();
  const topCandidates = allItems
    .filter((item) => item.mergeNow || item.reviewReady || item.nearMiss)
    .slice(0, limit * 2);

  // Also include non-actionable non-draft items for context
  const remaining = allItems
    .filter((item) => !item.mergeNow && !item.reviewReady && !item.nearMiss && !item.draft)
    .slice(0, limit);

  const toScore = [...topCandidates, ...remaining];

  const scored: QueueItem[] = [];
  for (const item of toScore) {
    const files = fetchPrFiles(repo, item.number);
    fileCache.set(item.number, files);
    const riskyFiles = files.filter(isRiskyFile);
    const { score, bucket, nextAction } = scoreItem(item, riskyFiles);

    scored.push({
      rank: 0,
      number: item.number,
      url: item.url,
      title: item.title,
      author: item.author,
      score,
      bucket,
      reasons: item.reasons,
      riskyFiles,
      churn: item.churn,
      changedFiles: item.changedFiles,
      nextAction,
      ageHours: item.createdAt
        ? Math.floor((Date.now() - new Date(item.createdAt).getTime()) / 3_600_000)
        : 0,
      labels: item.labels,
    });
  }

  // 4. Sort and rank
  scored.sort((a, b) => b.score - a.score);
  const queue = scored.filter((s) => s.bucket === "merge-now" || s.bucket === "review-ready").slice(0, limit);
  const nearMisses = scored.filter((s) => s.bucket === "salvage-now").slice(0, limit);
  queue.forEach((item, i) => (item.rank = i + 1));
  nearMisses.forEach((item, i) => (item.rank = i + 1));

  // 5. Detect hot clusters
  const hotClusters = detectHotClusters(allItems, repo, fileCache);

  // 6. Output
  const output: TriageOutput = {
    generatedAt: new Date().toISOString(),
    repo,
    scanned: prs.length,
    queue,
    nearMisses,
    hotClusters,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
