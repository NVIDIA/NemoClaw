#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import { upsertStickyComment } from "../advisors/github.mts";
import { parseArgs, readIfExists, readJsonIfExists } from "../advisors/io.mts";

const MARKER = "<!-- nemoclaw-pr-review-advisor -->";
const COMMENT_TITLE = "PR Review Advisor";

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
    category?: string;
    title?: string;
    file?: string | null;
    line?: number | null;
    description?: string;
    impact?: string;
    recommendation?: string;
    verificationHint?: string;
    missingRegressionTest?: string;
    evidence?: string;
    simplification?: {
      tag?: string;
      cut?: string;
      replacement?: string;
      estimatedNetLines?: number | null;
      safetyBoundary?: string;
    };
  }>;
};

type CommentMetadata = {
  runId?: string;
  runAttempt?: string;
  commentId?: string;
};

type Finding = NonNullable<ReviewAdvisorResult["findings"]>[number];

type FindingRecord = {
  id: string;
  finding: Finding;
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
  const resultPath =
    args.result || "artifacts/pr-review-advisor/pr-review-advisor-final-result.json";
  const { marker, title, label } = normalizeCommentOptions({
    marker: args.marker || process.env.PR_REVIEW_ADVISOR_COMMENT_MARKER || MARKER,
    title: args.title || process.env.PR_REVIEW_ADVISOR_COMMENT_TITLE || COMMENT_TITLE,
    label: args.label || process.env.PR_REVIEW_ADVISOR_COMMENT_LABEL || "PR review advisor",
  });
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
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

  const { summary, result } = readCommentArtifacts(summaryPath, resultPath, {
    summaryExplicit: Boolean(args.summary),
    resultExplicit: Boolean(args.result),
  });
  const baseMetadata = {
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  const body = buildComment({
    summary,
    result,
    runUrl,
    marker,
    title,
    metadata: baseMetadata,
  });

  await upsertStickyComment({
    repo,
    pr,
    token,
    marker,
    body,
    label,
    bodyForComment: (comment) =>
      buildComment({
        summary,
        result,
        runUrl,
        marker,
        title,
        metadata: { ...baseMetadata, commentId: String(comment.id) },
      }),
  });
}

export function normalizeCommentOptions({
  marker,
  title,
  label,
}: {
  marker: string;
  title: string;
  label: string;
}): { marker: string; title: string; label: string } {
  return {
    marker: validateCommentMarker(marker),
    title: validateSingleLineCommentField(title, "title"),
    label: validateSingleLineCommentField(label, "label"),
  };
}

function validateCommentMarker(marker: string): string {
  const value = marker.trim();
  if (!/^<!--\s+nemoclaw-pr-review-advisor(?:-[a-z0-9-]+)?\s+-->$/.test(value)) {
    throw new Error(
      "PR review advisor marker must be a safe nemoclaw-pr-review-advisor HTML comment",
    );
  }
  return value;
}

function validateSingleLineCommentField(value: string, field: "title" | "label"): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`PR review advisor ${field} must be a non-empty single-line string`);
  }
  return normalized;
}

export function readCommentArtifacts(
  summaryPath: string,
  resultPath: string,
  options: { summaryExplicit?: boolean; resultExplicit?: boolean } = {},
): { summary: string; result?: ReviewAdvisorResult } {
  const summary = options.summaryExplicit
    ? readIfExists(summaryPath)
    : readIfExists(summaryPath) ||
      readIfExists("artifacts/pr-review-advisor/pr-review-advisor-summary.md");
  if (!summary) throw new Error(`No PR review advisor summary found at ${summaryPath}`);
  const result = readJsonIfExists<ReviewAdvisorResult>(resultPath);
  if (options.resultExplicit && !result) {
    throw new Error(`No PR review advisor result found at ${resultPath}`);
  }
  return { summary, result };
}

export function buildComment({
  summary: _summary,
  result,
  runUrl,
  marker,
  title,
  metadata,
}: {
  summary: string;
  result?: ReviewAdvisorResult;
  runUrl?: string;
  marker?: string;
  title?: string;
  metadata?: CommentMetadata;
}): string {
  const findingRecords = collectFindingRecords(result);
  const blockerCount = findingRecords.filter(
    (record) => record.finding.severity === "blocker",
  ).length;
  const warningCount = findingRecords.filter(
    (record) => record.finding.severity === "warning",
  ).length;
  const suggestionCount = findingRecords.filter(
    (record) => record.finding.severity === "suggestion",
  ).length;
  const secondary = buildSecondarySummary(result);
  const informational =
    result?.summary?.recommendation === "info_only" && result.summary.oneLine
      ? `**Status:** ${escapeCommentText(result.summary.oneLine)}\n`
      : "";
  const findingsDetails = renderFindingsDetails(findingRecords);
  const details = runUrl ? `\n[Workflow run details](${runUrl})` : "";
  const hiddenMetadata = renderHiddenMetadata(result, metadata);
  const posture = reviewPosture(result?.summary?.recommendation, blockerCount);
  const headline = reviewHeadline(result?.summary?.recommendation, blockerCount);
  const heading = validateSingleLineCommentField(title || COMMENT_TITLE, "title");
  const renderedMarker = validateCommentMarker(marker || MARKER);
  return `${renderedMarker}
${hiddenMetadata}## ${heading} — ${headline}

**Merge posture:** ${posture}
**Primary next action:** ${primaryNextAction(findingRecords)}
**Findings:** ${compactCount(blockerCount, "required", "required")} · ${compactCount(warningCount, "warning")} · ${compactCount(suggestionCount, "optional suggestion")}
${informational}${secondary}${findingsDetails}${details}

This is an automated review. Required findings need action before merge. Warnings and optional suggestions do not require a response or follow-up. A human maintainer makes the final merge decision.

`;
}

function collectFindingRecords(result?: ReviewAdvisorResult): FindingRecord[] {
  return (result?.findings || []).map((finding, index) => ({
    id: `PRA-${index + 1}`,
    finding,
  }));
}

function renderHiddenMetadata(result?: ReviewAdvisorResult, metadata?: CommentMetadata): string {
  const fields = [
    result?.headSha ? `head_sha: ${safeMetadataValue(result.headSha)}` : undefined,
    result?.summary?.recommendation
      ? `recommendation: ${safeMetadataValue(result.summary.recommendation)}`
      : undefined,
    metadata?.runId ? `run_id: ${safeMetadataValue(metadata.runId)}` : undefined,
    metadata?.runAttempt ? `run_attempt: ${safeMetadataValue(metadata.runAttempt)}` : undefined,
    metadata?.commentId ? `comment_id: ${safeMetadataValue(metadata.commentId)}` : undefined,
  ].filter((field): field is string => Boolean(field));
  return fields.length > 0 ? `<!-- ${fields.join("; ")} -->\n` : "";
}

function safeMetadataValue(value: string): string {
  return value
    .replace(/[;\n\r<>]/g, "")
    .trim()
    .slice(0, 120);
}

function reviewHeadline(recommendation: string | undefined, blockerCount: number): string {
  if (blockerCount > 0) return "Changes requested";
  if (recommendation === "superseded") return "Superseded";
  if (recommendation === "info_only") return "Informational";
  return "No blocking findings";
}

function reviewPosture(recommendation: string | undefined, blockerCount: number): string {
  if (blockerCount > 0) return "Do not merge until required findings are fixed";
  if (recommendation === "superseded") return "Superseded by other work";
  if (recommendation === "info_only") return "Informational / low confidence";
  return "No blocking advisor findings";
}

function primaryNextAction(records: FindingRecord[]): string {
  if (records.some((record) => record.finding.severity === "blocker")) {
    return "Fix the required findings below.";
  }
  if (records.some((record) => record.finding.severity === "warning")) {
    return "Review the warnings below.";
  }
  if (records.some((record) => record.finding.severity === "suggestion")) {
    return "Optional suggestions are listed below.";
  }
  return "No advisor follow-up required beyond maintainer review.";
}

function buildSecondarySummary(result?: ReviewAdvisorResult): string {
  const sinceLastReview = result?.summary?.sinceLastReview;
  if (sinceLastReview) {
    return `**Since last review:** ${countLabel(sinceLastReview.resolved, "prior item")} resolved · ${countLabel(sinceLastReview.stillApplies, "still applies", "still apply")} · ${countLabel(sinceLastReview.newItems, "new item")} found\n`;
  }
  return "";
}

function renderFindingsDetails(records: FindingRecord[]): string {
  if (records.length === 0) return "";
  const blockerFindings = records.filter((record) => record.finding.severity === "blocker");
  const warningFindings = records.filter((record) => record.finding.severity === "warning");
  const suggestionFindings = records.filter((record) => record.finding.severity === "suggestion");
  const lines: string[] = [];
  if (blockerFindings.length > 0) {
    lines.push("", "### Required before merge", "");
    for (const record of blockerFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  if (warningFindings.length === 0 && suggestionFindings.length === 0)
    return `${lines.join("\n")}\n`;
  lines.push(
    "",
    "<details>",
    `<summary>${countLabel(warningFindings.length, "warning")} · ${countLabel(suggestionFindings.length, "optional suggestion")}</summary>`,
    "",
  );
  if (warningFindings.length > 0) {
    lines.push(
      "### Warnings",
      "_These merit maintainer attention but do not block by themselves._",
      "",
    );
    for (const record of warningFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  if (suggestionFindings.length > 0) {
    lines.push(
      "### Suggestions (optional)",
      "_No response or follow-up is expected for these suggestions._",
      "",
    );
    for (const record of suggestionFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  lines.push("</details>", "");
  return `${lines.join("\n")}\n`;
}

function formatFinding(record: FindingRecord): string {
  const finding = record.finding;
  const title = escapeCommentText(findingTitle(finding));
  const lines = [`#### \`${record.id}\` ${severityLabel(finding.severity)} — ${title}`];
  lines.push(`- **Location:** ${formatInlineLocation(finding) || "not file-specific"}`);
  lines.push(`- **Category:** ${escapeCommentText(finding.category || "uncategorized")}`);
  if (finding.description) lines.push(`- **Problem:** ${escapeCommentText(finding.description)}`);
  if (finding.impact) lines.push(`- **Impact:** ${escapeCommentText(finding.impact)}`);
  if (finding.recommendation) {
    lines.push(
      `- **${actionFieldLabel(finding.severity)}:** ${escapeCommentText(finding.recommendation)}`,
    );
  }
  if (finding.verificationHint) {
    lines.push(`- **Verification:** ${escapeCommentText(finding.verificationHint)}`);
  }
  if (finding.missingRegressionTest) {
    lines.push(`- **Test coverage:** ${escapeCommentText(finding.missingRegressionTest)}`);
  }
  if (finding.simplification) {
    const item = finding.simplification;
    const net =
      typeof item.estimatedNetLines === "number" ? ` Net: ${item.estimatedNetLines} lines.` : "";
    lines.push(
      `- **Simplification (${escapeCommentText(item.tag || "shrink")}):** Remove ${escapeCommentText(item.cut || finding.title || "the custom path")}; use ${escapeCommentText(item.replacement || "the simpler existing path")}.${net}`,
    );
    if (item.safetyBoundary) {
      lines.push(`- **Keep:** ${escapeCommentText(item.safetyBoundary)}`);
    }
  }
  if (finding.evidence) lines.push(`- **Evidence:** ${escapeCommentText(finding.evidence)}`);
  return lines.join("\n");
}

function findingTitle(finding: Finding): string {
  return finding.title || "Review finding";
}

function severityLabel(severity?: string): string {
  if (severity === "blocker") return "Required";
  if (severity === "warning") return "Warning";
  if (severity === "suggestion") return "Optional";
  return "Review";
}

function actionFieldLabel(severity?: string): string {
  if (severity === "blocker") return "Required action";
  if (severity === "warning") return "Recommendation";
  if (severity === "suggestion") return "Optional change";
  return "Recommendation";
}

function formatInlineLocation(finding: Finding): string {
  if (!finding.file) return "";
  const line = Number.isInteger(finding.line) && Number(finding.line) > 0 ? `:${finding.line}` : "";
  return `<code>${escapeLocationHtml(`${finding.file}${line}`)}</code>`;
}

function escapeLocationHtml(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("@", "&#64;");
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

function compactCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
