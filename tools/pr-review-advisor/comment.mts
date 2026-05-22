#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import { upsertStickyComment } from "../advisors/github.mts";
import { parseArgs, readIfExists, readJsonIfExists } from "../advisors/io.mts";

const MARKER = "<!-- nemoclaw-pr-review-advisor -->";

type ReviewAdvisorResult = {
  headSha?: string;
  summary?: {
    recommendation?: string;
    confidence?: string;
    oneLine?: string;
  };
  findings?: Array<{ severity?: string }>;
  reviewCompleteness?: {
    limitations?: string[];
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  const pr = args.pr || process.env.PR_NUMBER;
  const summaryPath = args.summary || "artifacts/pr-review-advisor/pr-review-advisor-summary.md";
  const resultPath = args.result || "artifacts/pr-review-advisor/pr-review-advisor-final-result.json";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;

  if (!repo || !pr) {
    console.log("Skipping PR review advisor comment: repo or PR number not provided");
    return;
  }
  if (!token) {
    console.log("Skipping PR review advisor comment: GITHUB_TOKEN/GH_TOKEN not provided");
    return;
  }

  const summary = readIfExists(summaryPath) || readIfExists("artifacts/pr-review-advisor/pr-review-advisor-summary.md");
  if (!summary) throw new Error(`No PR review advisor summary found at ${summaryPath}`);
  const result = readJsonIfExists<ReviewAdvisorResult>(resultPath);
  const body = buildComment({ summary, result, runUrl, marker: MARKER });

  await upsertStickyComment({ repo, pr, token, marker: MARKER, body, label: "PR review advisor" });
}

export function buildComment({
  summary,
  result,
  runUrl,
  marker,
}: {
  summary: string;
  result?: ReviewAdvisorResult;
  runUrl?: string;
  marker?: string;
}): string {
  const blockerCount = result?.findings?.filter((finding) => finding.severity === "blocker").length ?? 0;
  const warningCount = result?.findings?.filter((finding) => finding.severity === "warning").length ?? 0;
  const suggestionCount = result?.findings?.filter((finding) => finding.severity === "suggestion").length ?? 0;
  const recommendation = result?.summary?.recommendation ? result.summary.recommendation.replaceAll("_", " ") : "unknown";
  const confidence = result?.summary?.confidence || "unknown";
  const sha = result?.headSha ? `\n**Analyzed HEAD:** \`${result.headSha}\`` : "";
  const run = runUrl ? `\n\n[Workflow run](${runUrl})` : "";
  const limitations = result?.reviewCompleteness?.limitations?.length
    ? `\n\n**Limitations:** ${result.reviewCompleteness.limitations.join("; ")}`
    : "";

  return `${marker || MARKER}
## PR Review Advisor

**Recommendation:** ${recommendation}
**Confidence:** ${confidence}${sha}
**Findings:** ${blockerCount} blocker(s), ${warningCount} warning(s), ${suggestionCount} suggestion(s)

This is an automated advisory review. A human maintainer must make the final merge decision.${limitations}${run}

<details>
<summary>Full advisor summary</summary>

${summary.trim()}

</details>
`;
}
