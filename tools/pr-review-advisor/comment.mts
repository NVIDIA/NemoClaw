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
    topItem?: string;
    sinceLastReview?: {
      resolved?: number;
      stillApplies?: number;
      newItems?: number;
    };
  };
  findings?: Array<{
    severity?: string;
    title?: string;
    file?: string | null;
    line?: number | null;
    description?: string;
    recommendation?: string;
    evidence?: string;
  }>;
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
  summary: _summary,
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
  const secondary = buildSecondarySummary(result);
  const findingsDetails = renderFindingsDetails(result);
  const previousReviewDetails = renderPreviousReviewDetails(result);
  const details = runUrl
    ? `\n[Workflow run details](${runUrl})`
    : "";
  return `${marker || MARKER}
## PR Review Advisor

**Findings:** ${blockerCount} needs attention, ${warningCount} worth checking, ${suggestionCount} nice ideas
${secondary}${findingsDetails}${previousReviewDetails}${details}

This is an automated advisory review. A human maintainer must make the final merge decision.

`;
}

function buildSecondarySummary(result?: ReviewAdvisorResult): string {
  const sinceLastReview = result?.summary?.sinceLastReview;
  if (sinceLastReview) {
    return `**Since last review:** ${countLabel(sinceLastReview.resolved, "prior item")} resolved, ${countLabel(sinceLastReview.stillApplies, "still applies", "still apply")}, ${countLabel(sinceLastReview.newItems, "new item")} found\n`;
  }
  const topItem = result?.summary?.topItem || topFindingTitle(result);
  return topItem ? `**Top item:** ${escapeCommentText(topItem)}\n` : "";
}

function topFindingTitle(result?: ReviewAdvisorResult): string | undefined {
  return result?.findings?.find((finding) => finding.severity === "blocker")?.title ||
    result?.findings?.find((finding) => finding.severity === "warning")?.title ||
    result?.findings?.find((finding) => finding.severity === "suggestion")?.title;
}

function renderFindingsDetails(result?: ReviewAdvisorResult): string {
  if (!result?.findings?.length) return "";
  const sections = [
    { summary: "🛠️ Needs attention", findings: result.findings.filter((finding) => finding.severity === "blocker") },
    { summary: "🔎 Worth checking", findings: result.findings.filter((finding) => finding.severity === "warning") },
    { summary: "🌱 Nice ideas", findings: result.findings.filter((finding) => finding.severity === "suggestion") },
  ];
  const lines: string[] = ["", "<details>", "<summary>Review findings</summary>", ""];
  for (const section of sections) {
    lines.push(`### ${section.summary}`);
    if (section.findings.length === 0) {
      lines.push("- _None._");
    } else {
      for (const finding of section.findings.slice(0, 20)) {
        lines.push(formatFinding(finding));
      }
    }
    lines.push("");
  }
  lines.push("</details>", "");
  return `${lines.join("\n")}\n`;
}

function renderPreviousReviewDetails(result?: ReviewAdvisorResult): string {
  const sinceLastReview = result?.summary?.sinceLastReview;
  if (!sinceLastReview || !result?.findings?.length) return "";
  const lines: string[] = ["<details>", "<summary>Since last review details</summary>", ""];
  lines.push("Current findings:");
  for (const finding of result.findings.slice(0, 20)) lines.push(formatFinding(finding));
  lines.push("", "</details>", "");
  return `${lines.join("\n")}\n`;
}

function formatFinding(finding: NonNullable<ReviewAdvisorResult["findings"]>[number]): string {
  const title = escapeCommentText(finding.title || "Review finding");
  const location = formatFindingLocation(finding);
  const description = finding.description ? `: ${escapeCommentText(finding.description)}` : "";
  const lines = [`- **${title}**${location}${description}`];
  if (finding.recommendation) {
    lines.push(`  - Recommendation: ${escapeCommentText(finding.recommendation)}`);
  }
  if (finding.evidence) lines.push(`  - Evidence: ${escapeCommentText(finding.evidence)}`);
  return lines.join("\n");
}

function formatFindingLocation(finding: NonNullable<ReviewAdvisorResult["findings"]>[number]): string {
  if (!finding.file) return "";
  const line = Number.isInteger(finding.line) && Number(finding.line) > 0 ? `:${finding.line}` : "";
  return ` (${escapeCommentText(finding.file)}${line})`;
}

function escapeCommentText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_\[\]()!|])/g, "\\$1")
    .replaceAll("@", "&#64;");
}

function countLabel(count: unknown, singular: string, plural = `${singular}s`): string {
  const numeric = typeof count === "number" && Number.isFinite(count) ? count : 0;
  return `${numeric} ${numeric === 1 ? singular : plural}`;
}
