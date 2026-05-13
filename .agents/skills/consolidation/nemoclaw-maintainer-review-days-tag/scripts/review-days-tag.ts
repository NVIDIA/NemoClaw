// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sweep every open PR that carries a given version label and produce a
 * prioritized review queue.
 *
 * For each PR we gather mergeability, CI status, CodeRabbit unresolved
 * threads, reviewer decision, draft state, author, age, and size. We then
 * classify the PR into a next-action bucket so the maintainer can work
 * through the whole day's tag in one pass.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings \
 *     .agents/skills/nemoclaw-maintainer-review-days-tag/scripts/review-days-tag.ts \
 *     <version> [--repo OWNER/REPO] [--json]
 */

import {
  ghJson,
  parseStringArg,
  REQUIRED_CHECK_NAMES,
  type StatusCheck,
} from "../../nemoclaw-maintainer-day/scripts/shared.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bucket =
  | "APPROVE"
  | "SALVAGE"
  | "CODERABBIT"
  | "WAIT"
  | "CONTRIBUTOR"
  | "DRAFT"
  | "BLOCKED";

interface PrSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  ageDays: number;
  additions: number;
  deletions: number;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeStateStatus: string;
  ciState: "green" | "failing" | "pending" | "missing" | "unknown";
  failingChecks: string[];
  pendingChecks: string[];
  missingChecks: string[];
  coderabbitMajor: number;
  bucket: Bucket;
  nextAction: string;
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  additions: number;
  deletions: number;
  author: { login: string } | null;
  reviewDecision: string | null;
  mergeStateStatus: string;
  statusCheckRollup: StatusCheck[] | null;
  reviews?: Array<{ author: { login: string } | null; body: string; state: string }>;
  comments?: Array<{ author: { login: string } | null; body: string }>;
}

// ---------------------------------------------------------------------------
// Bucket ordering — sorted highest-priority first so queue output is ready-to-work
// ---------------------------------------------------------------------------

const BUCKET_ORDER: Bucket[] = [
  "APPROVE",
  "SALVAGE",
  "CODERABBIT",
  "CONTRIBUTOR",
  "WAIT",
  "DRAFT",
  "BLOCKED",
];

// ---------------------------------------------------------------------------
// CI analysis
// ---------------------------------------------------------------------------

function analyzeCi(rollup: StatusCheck[] | null): {
  ciState: PrSummary["ciState"];
  failingChecks: string[];
  pendingChecks: string[];
  missingChecks: string[];
} {
  if (!rollup || rollup.length === 0) {
    return {
      ciState: "missing",
      failingChecks: [],
      pendingChecks: [],
      missingChecks: [...REQUIRED_CHECK_NAMES],
    };
  }

  const presentNames = new Set(
    rollup.map((c) => c.name ?? c.context ?? "").filter(Boolean),
  );
  const missingChecks = REQUIRED_CHECK_NAMES.filter((n) => !presentNames.has(n));

  const passing = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const failing: string[] = [];
  const pending: string[] = [];

  for (const check of rollup) {
    const name = check.name ?? check.context ?? "(unknown)";

    if (check.__typename === "StatusContext") {
      const state = (check.state ?? "").toUpperCase();
      if (state === "SUCCESS") continue;
      if (state === "PENDING") pending.push(name);
      else failing.push(name);
      continue;
    }

    // CheckRun
    const status = (check.status ?? "").toUpperCase();
    const conclusion = (check.conclusion ?? "").toUpperCase();
    if (status !== "COMPLETED") {
      pending.push(name);
      continue;
    }
    if (!passing.has(conclusion)) failing.push(name);
  }

  if (missingChecks.length > 0) {
    return { ciState: "missing", failingChecks: failing, pendingChecks: pending, missingChecks };
  }
  if (failing.length > 0) {
    return { ciState: "failing", failingChecks: failing, pendingChecks: pending, missingChecks };
  }
  if (pending.length > 0) {
    return { ciState: "pending", failingChecks: failing, pendingChecks: pending, missingChecks };
  }
  return { ciState: "green", failingChecks: [], pendingChecks: [], missingChecks: [] };
}

// ---------------------------------------------------------------------------
// CodeRabbit analysis (lightweight: count major/critical in review bodies)
// ---------------------------------------------------------------------------

function countCodeRabbitMajor(pr: RawPr): number {
  const bodies: string[] = [];
  for (const r of pr.reviews ?? []) {
    const login = r.author?.login ?? "";
    if (/coderabbit/i.test(login)) bodies.push(r.body ?? "");
  }
  for (const c of pr.comments ?? []) {
    const login = c.author?.login ?? "";
    if (/coderabbit/i.test(login)) bodies.push(c.body ?? "");
  }
  let count = 0;
  for (const body of bodies) {
    // CodeRabbit uses "_⚠️ Potential issue_" and "_🛠️ Refactor suggestion_"
    // and severity tags like "major" / "critical" in its inline review bodies.
    const majorMatches = body.match(/potential issue|major|critical|security/gi);
    if (majorMatches) count += majorMatches.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Bucket classification
// ---------------------------------------------------------------------------

function classify(s: Omit<PrSummary, "bucket" | "nextAction">): {
  bucket: Bucket;
  nextAction: string;
} {
  if (s.isDraft) {
    return { bucket: "DRAFT", nextAction: "Skip — marked draft" };
  }
  if (s.ciState === "missing") {
    return {
      bucket: "BLOCKED",
      nextAction: `Click "Approve and run" on Actions tab (missing: ${s.missingChecks.join(", ")})`,
    };
  }
  if (s.mergeStateStatus === "DIRTY") {
    return { bucket: "SALVAGE", nextAction: "Rebase onto main" };
  }
  if (s.ciState === "failing") {
    const narrow = s.failingChecks.length <= 2;
    return {
      bucket: "SALVAGE",
      nextAction: narrow
        ? `Inspect/rerun: ${s.failingChecks.join(", ")}`
        : `Broad CI red (${s.failingChecks.length}) — route to SALVAGE-PR.md`,
    };
  }
  if (s.coderabbitMajor > 0) {
    return {
      bucket: "CODERABBIT",
      nextAction: `Address ${s.coderabbitMajor} unresolved CodeRabbit thread(s)`,
    };
  }
  if (s.reviewDecision === "CHANGES_REQUESTED") {
    return { bucket: "CONTRIBUTOR", nextAction: "Waiting on author for requested changes" };
  }
  if (s.ciState === "pending") {
    return {
      bucket: "WAIT",
      nextAction: `CI running (${s.pendingChecks.length} pending) — re-check later`,
    };
  }
  // All gates look green from here — still requires a human final review
  if (s.reviewDecision === "APPROVED") {
    return { bucket: "APPROVE", nextAction: "Run merge-gate — ready to flag as merge-ready" };
  }
  return { bucket: "APPROVE", nextAction: "Run merge-gate + approve" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

function summarize(pr: RawPr): PrSummary {
  const ci = analyzeCi(pr.statusCheckRollup);
  const partial: Omit<PrSummary, "bucket" | "nextAction"> = {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? "(unknown)",
    ageDays: daysSince(pr.createdAt),
    additions: pr.additions,
    deletions: pr.deletions,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision,
    mergeStateStatus: pr.mergeStateStatus,
    ciState: ci.ciState,
    failingChecks: ci.failingChecks,
    pendingChecks: ci.pendingChecks,
    missingChecks: ci.missingChecks,
    coderabbitMajor: countCodeRabbitMajor(pr),
  };
  const { bucket, nextAction } = classify(partial);
  return { ...partial, bucket, nextAction };
}

function renderTable(version: string, rows: PrSummary[]): string {
  rows.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket);
    const bi = BUCKET_ORDER.indexOf(b.bucket);
    if (ai !== bi) return ai - bi;
    return b.ageDays - a.ageDays; // older first inside bucket
  });

  const lines: string[] = [];
  lines.push(`### Day's tag review — ${version} (${rows.length} open PR${rows.length === 1 ? "" : "s"})`);
  lines.push("");
  if (rows.length === 0) {
    lines.push(`_No open PRs carry the ${version} label. Run \`/nemoclaw-maintainer-morning\` or confirm the target version._`);
    return lines.join("\n");
  }
  lines.push("| Bucket | PR | Title | Author | CI | CR | Conflicts | Age | Next action |");
  lines.push("|--------|----|-------|--------|----|----|-----------|-----|-------------|");

  const ciIcon: Record<PrSummary["ciState"], string> = {
    green: "✅",
    failing: "❌",
    pending: "⏳",
    missing: "⚠ missing",
    unknown: "?",
  };

  for (const r of rows) {
    const title = r.title.length > 60 ? r.title.slice(0, 57) + "…" : r.title;
    const ci = ciIcon[r.ciState];
    const cr = r.coderabbitMajor === 0 ? "✅" : `⚠ ${r.coderabbitMajor}`;
    const conflicts = r.mergeStateStatus === "DIRTY" ? "DIRTY" : "clean";
    lines.push(
      `| ${r.bucket} | [#${r.number}](${r.url}) | ${title} | @${r.author} | ${ci} | ${cr} | ${conflicts} | ${r.ageDays}d | ${r.nextAction} |`,
    );
  }

  // Summary block
  const byBucket = new Map<Bucket, number>();
  for (const r of rows) byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + 1);
  lines.push("");
  lines.push("**Buckets:** " + BUCKET_ORDER
    .filter((b) => byBucket.has(b))
    .map((b) => `${b}=${byBucket.get(b)}`)
    .join(", "));

  const approvable = rows.filter((r) => r.bucket === "APPROVE");
  if (approvable.length > 0) {
    lines.push("");
    lines.push("**Approvals available (run merge-gate on these):**");
    for (const r of approvable) lines.push(`- #${r.number} — ${r.title}`);
  }

  const stragglers = rows.filter((r) =>
    r.bucket === "CODERABBIT" || r.bucket === "CONTRIBUTOR" || r.bucket === "BLOCKED",
  );
  if (stragglers.length > 0) {
    lines.push("");
    lines.push(`**Stragglers risk:** ${stragglers.length} PR(s) unlikely to land today (need author or external action).`);
  }

  // Recommend first review target: oldest APPROVE, else oldest SALVAGE
  const firstBucket = rows.find((r) => r.bucket === "APPROVE") ?? rows.find((r) => r.bucket === "SALVAGE");
  if (firstBucket) {
    lines.push("");
    lines.push(`**Review first:** #${firstBucket.number} — ${firstBucket.nextAction}`);
  }
  return lines.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const repo = parseStringArg(args, "--repo", "NVIDIA/NemoClaw");

  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--repo");
  const version = positional[0];
  if (!version) {
    process.stderr.write(
      "[review-days-tag] missing <version> argument. Run version-target.ts first.\n",
    );
    process.exit(2);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    process.stderr.write(`[review-days-tag] invalid version "${version}". Expected vMAJOR.MINOR.PATCH.\n`);
    process.exit(2);
  }

  const raw = ghJson([
    "pr", "list",
    "--repo", repo,
    "--state", "open",
    "--label", version,
    "--limit", "200",
    "--json",
    "number,title,url,isDraft,createdAt,additions,deletions,author,reviewDecision,mergeStateStatus,statusCheckRollup,reviews,comments",
  ]) as RawPr[] | null;

  const prs = raw ?? [];
  const summaries = prs.map(summarize);

  if (jsonMode) {
    console.log(JSON.stringify({ version, repo, count: summaries.length, prs: summaries }, null, 2));
    return;
  }

  console.log(renderTable(version, summaries));
}

main();
