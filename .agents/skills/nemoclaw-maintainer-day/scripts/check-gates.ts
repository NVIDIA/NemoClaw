// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic merge-gate checker for a single NemoClaw PR.
 *
 * Checks all 4 required gates and outputs structured JSON.
 * Claude uses the output to decide: approve, route to salvage, or report blockers.
 *
 * Usage: node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number> [--repo OWNER/REPO]
 */

import { isRiskyFile, isTestFile, run, ghJson, parseStringArg } from "./shared.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GateResult {
  pass: boolean;
  details: string;
}

interface CodeRabbitThread {
  path: string;
  severity: "critical" | "major" | "minor" | "unknown";
  snippet: string;
  resolved: boolean;
}

interface GateOutput {
  pr: number;
  url: string;
  title: string;
  allPass: boolean;
  gates: {
    ci: GateResult & { failingChecks?: string[]; pendingChecks?: string[] };
    conflicts: GateResult & { mergeStateStatus?: string };
    coderabbit: GateResult & { unresolvedThreads?: CodeRabbitThread[] };
    riskyCodeTested: GateResult & { riskyFiles?: string[]; hasTests?: boolean };
  };
}

// ---------------------------------------------------------------------------
// Gate 1: CI green
// ---------------------------------------------------------------------------

function checkCi(
  statusCheckRollup: Array<{ name: string; status: string; conclusion: string }> | null,
): GateResult & { failingChecks?: string[]; pendingChecks?: string[] } {
  if (!statusCheckRollup || statusCheckRollup.length === 0) {
    return { pass: false, details: "No status checks found" };
  }

  const passing = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const failing: string[] = [];
  const pending: string[] = [];

  for (const check of statusCheckRollup) {
    const conclusion = (check.conclusion ?? "").toUpperCase();
    const status = (check.status ?? "").toUpperCase();

    // CodeRabbit reports as a commit status with null name/status but a
    // non-null conclusion. Treat it as completed if conclusion is present.
    const effectivelyCompleted = status === "COMPLETED" || (!status && conclusion);

    if (!effectivelyCompleted) {
      pending.push(check.name ?? "(unknown)");
    } else if (!passing.has(conclusion)) {
      failing.push(`${check.name ?? "(unknown)"}: ${conclusion}`);
    }
  }

  if (failing.length > 0) {
    return { pass: false, details: `${failing.length} failing check(s)`, failingChecks: failing, pendingChecks: pending };
  }
  if (pending.length > 0) {
    return { pass: false, details: `${pending.length} pending check(s)`, pendingChecks: pending };
  }
  return { pass: true, details: `All ${statusCheckRollup.length} checks green` };
}

// ---------------------------------------------------------------------------
// Gate 2: No conflicts
// ---------------------------------------------------------------------------

function checkConflicts(mergeStateStatus: string): GateResult & { mergeStateStatus?: string } {
  const clean = ["CLEAN", "HAS_HOOKS", "UNSTABLE"];
  const status = (mergeStateStatus ?? "UNKNOWN").toUpperCase();

  if (clean.includes(status)) {
    return { pass: true, details: "No merge conflicts", mergeStateStatus: status };
  }
  return { pass: false, details: `Merge state: ${status}`, mergeStateStatus: status };
}

// ---------------------------------------------------------------------------
// Gate 3: CodeRabbit
// ---------------------------------------------------------------------------

const SEVERITY_MARKERS = {
  critical: ["🔴 Critical", "_🔴 Critical_", "Critical:"],
  major: ["🟠 Major", "_🟠 Major_"],
  minor: ["🟡 Minor", "_🟡 Minor_"],
} as const;

const CODERABBIT_LOGINS = new Set(["coderabbitai[bot]", "coderabbitai"]);
const ADDRESSED_MARKERS = ["✅ Addressed in commit", "<review_comment_addressed>"];

function detectSeverity(body: string): "critical" | "major" | "minor" | "unknown" {
  for (const marker of SEVERITY_MARKERS.critical) {
    if (body.includes(marker)) return "critical";
  }
  for (const marker of SEVERITY_MARKERS.major) {
    if (body.includes(marker)) return "major";
  }
  for (const marker of SEVERITY_MARKERS.minor) {
    if (body.includes(marker)) return "minor";
  }
  return "unknown";
}

function isAddressed(body: string): boolean {
  return ADDRESSED_MARKERS.some((m) => body.includes(m));
}

function checkCodeRabbit(
  repo: string,
  number: number,
): GateResult & { unresolvedThreads?: CodeRabbitThread[] } {
  const query = `query($owner:String!, $repo:String!, $number:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) {
        reviewThreads(first:100) {
          nodes {
            isResolved
            comments(first:20) {
              nodes { author { login } body path }
            }
          }
        }
      }
    }
  }`;

  const [owner, repoName] = repo.split("/");
  const out = run("gh", [
    "api", "graphql",
    "-F", `owner=${owner}`,
    "-F", `repo=${repoName}`,
    "-F", `number=${number}`,
    "-f", `query=${query}`,
  ]);

  // Fail-closed: if we cannot reach the API, do not assume clean
  if (!out) {
    return { pass: false, details: "Could not fetch review threads (API error — fail-closed)" };
  }

  let data: {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<{
              isResolved: boolean;
              comments: { nodes: Array<{ author: { login: string }; body: string; path: string }> };
            }>;
          };
        };
      };
    };
  };
  try {
    data = JSON.parse(out);
  } catch {
    return { pass: false, details: "Could not parse review threads (invalid JSON — fail-closed)" };
  }

  const threads = data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const unresolved: CodeRabbitThread[] = [];

  for (const thread of threads) {
    if (thread.isResolved) continue;

    const comments = thread.comments.nodes;
    const coderabbitComments = comments.filter(
      (c) => CODERABBIT_LOGINS.has(c.author?.login?.toLowerCase()),
    );

    for (const comment of coderabbitComments) {
      if (isAddressed(comment.body)) continue;
      const severity = detectSeverity(comment.body);
      if (severity === "critical" || severity === "major") {
        unresolved.push({
          path: comment.path || "(unknown)",
          severity,
          snippet: comment.body.slice(0, 200),
          resolved: false,
        });
      }
    }
  }

  if (unresolved.length === 0) {
    return { pass: true, details: "No unresolved major/critical CodeRabbit findings" };
  }
  return {
    pass: false,
    details: `${unresolved.length} unresolved major/critical CodeRabbit finding(s)`,
    unresolvedThreads: unresolved,
  };
}

// ---------------------------------------------------------------------------
// Gate 4: Risky code has tests
// ---------------------------------------------------------------------------

function checkRiskyCodeTested(
  files: Array<{ path: string; status: string }>,
): GateResult & { riskyFiles?: string[]; hasTests?: boolean } {
  const riskyFiles = files.map((f) => f.path).filter(isRiskyFile);
  if (riskyFiles.length === 0) {
    return { pass: true, details: "No risky files changed" };
  }

  const hasTests = files.some((f) => isTestFile(f.path));
  if (hasTests) {
    return {
      pass: true,
      details: `${riskyFiles.length} risky file(s) changed; test files present in PR`,
      riskyFiles,
      hasTests: true,
    };
  }

  return {
    pass: false,
    details: `${riskyFiles.length} risky file(s) changed but no test files in PR`,
    riskyFiles,
    hasTests: false,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: check-gates.ts <pr-number> [--repo OWNER/REPO]");
    process.exit(1);
  }

  const repo = parseStringArg(args, "--repo", "NVIDIA/NemoClaw");

  const prData = ghJson([
    "pr", "view", String(prNumber),
    "--repo", repo,
    "--json", "number,title,url,files,statusCheckRollup,mergeStateStatus",
  ]) as {
    number: number;
    title: string;
    url: string;
    files: Array<{ path: string; status: string }>;
    statusCheckRollup: Array<{ name: string; status: string; conclusion: string }>;
    mergeStateStatus: string;
  } | null;

  if (!prData) {
    console.error(`Failed to fetch PR #${prNumber} from ${repo}`);
    process.exit(1);
  }

  const ci = checkCi(prData.statusCheckRollup);
  const conflicts = checkConflicts(prData.mergeStateStatus);
  const coderabbit = checkCodeRabbit(repo, prNumber);
  const riskyCodeTested = checkRiskyCodeTested(prData.files ?? []);

  const output: GateOutput = {
    pr: prNumber,
    url: prData.url,
    title: prData.title,
    allPass: ci.pass && conflicts.pass && coderabbit.pass && riskyCodeTested.pass,
    gates: { ci, conflicts, coderabbit, riskyCodeTested },
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
