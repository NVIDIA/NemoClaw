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
  acceptanceCoverage?: Array<{
    clause?: string;
    status?: string;
    evidence?: string;
  }>;
  sourceOfTruthReview?: Array<{
    surface?: string;
    status?: string;
    regressionTest?: string;
    evidence?: string;
  }>;
  testDepth?: {
    verdict?: string;
    rationale?: string;
    suggestedTests?: string[];
  };
  reviewCompleteness?: {
    limitations?: string[];
  };
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

type TestingFollowup = {
  label: string;
  text: string;
};

type TestingFollowupRecord = {
  id: string;
  followup: TestingFollowup;
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

  const summary =
    readIfExists(summaryPath) ||
    readIfExists("artifacts/pr-review-advisor/pr-review-advisor-summary.md");
  if (!summary) throw new Error(`No PR review advisor summary found at ${summaryPath}`);
  const result = readJsonIfExists<ReviewAdvisorResult>(resultPath);
  const baseMetadata = {
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  const body = buildComment({
    summary,
    result,
    runUrl,
    marker: MARKER,
    metadata: baseMetadata,
  });

  await upsertStickyComment({
    repo,
    pr,
    token,
    marker: MARKER,
    body,
    label: "PR review advisor",
    bodyForComment: (comment) =>
      buildComment({
        summary,
        result,
        runUrl,
        marker: MARKER,
        metadata: { ...baseMetadata, commentId: String(comment.id) },
      }),
  });
}

export function buildComment({
  summary: _summary,
  result,
  runUrl,
  marker,
  metadata,
}: {
  summary: string;
  result?: ReviewAdvisorResult;
  runUrl?: string;
  marker?: string;
  metadata?: CommentMetadata;
}): string {
  const findingRecords = collectFindingRecords(result);
  const testingFollowups = collectTestingFollowupRecords(result);
  const blockerCount = findingRecords.filter(
    (record) => record.finding.severity === "blocker",
  ).length;
  const warningCount = findingRecords.filter(
    (record) => record.finding.severity === "warning",
  ).length;
  const suggestionCount = findingRecords.filter(
    (record) => record.finding.severity === "suggestion",
  ).length;
  const secondary = buildSecondarySummary(result, findingRecords);
  const actionChecklist = renderActionChecklist(findingRecords, testingFollowups);
  const findingsIndex = renderFindingsIndex(findingRecords);
  const findingsDetails = renderFindingsDetails(findingRecords);
  const simplificationDetails = renderSimplificationDetails(findingRecords);
  const testingFollowupsDetails = renderTestingFollowupsDetails(testingFollowups);
  const previousReviewDetails = renderPreviousReviewDetails(result, findingRecords);
  const details = runUrl ? `\n[Workflow run details](${runUrl})` : "";
  const hiddenMetadata = renderHiddenMetadata(result, metadata);
  const posture = reviewPosture(result?.summary?.recommendation);
  const headline = reviewHeadline(result?.summary?.recommendation);
  return `${marker || MARKER}
${hiddenMetadata}## PR Review Advisor — ${headline}

**Merge posture:** ${posture}
**Primary next action:** ${primaryNextAction(findingRecords, testingFollowups)}
**Open items:** ${compactCount(blockerCount, "required", "required")} · ${compactCount(warningCount, "warning")} · ${compactCount(suggestionCount, "suggestion")} · ${compactCount(testingFollowups.length, "test follow-up")}
${secondary}${actionChecklist}${findingsIndex}${findingsDetails}${simplificationDetails}${testingFollowupsDetails}${previousReviewDetails}${details}

This is an automated, non-binding review; it still expects maintainers and agents to respond to each required or warning item. Treat suggestions as current-PR improvements when they touch changed code; defer only with maintainer rationale or a linked follow-up. A human maintainer must make the final merge decision.

`;
}

function collectFindingRecords(result?: ReviewAdvisorResult): FindingRecord[] {
  return (result?.findings || []).map((finding, index) => ({
    id: `PRA-${index + 1}`,
    finding,
  }));
}

function collectTestingFollowupRecords(result?: ReviewAdvisorResult): TestingFollowupRecord[] {
  return collectTestingFollowups(result).map((followup, index) => ({
    id: `PRA-T${index + 1}`,
    followup,
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

function reviewHeadline(recommendation?: string): string {
  if (recommendation === "merge_as_is") return "No blocking findings";
  if (recommendation === "merge_after_fixes") return "Changes requested";
  if (recommendation === "needs_rework" || recommendation === "blocked") return "Blocked";
  if (recommendation === "superseded") return "Superseded";
  if (recommendation === "info_only") return "Informational";
  return "Review ready";
}

function reviewPosture(recommendation?: string): string {
  if (recommendation === "merge_as_is") return "No blocking advisor findings";
  if (recommendation === "merge_after_fixes") return "Do not merge yet";
  if (recommendation === "needs_rework" || recommendation === "blocked") {
    return "Do not merge until addressed";
  }
  if (recommendation === "superseded") return "Superseded by other work";
  if (recommendation === "info_only") return "Informational / low confidence";
  return "Review findings and decide before merge";
}

function primaryNextAction(
  records: FindingRecord[],
  testingFollowups: TestingFollowupRecord[],
): string {
  const blocker = records.find((record) => record.finding.severity === "blocker");
  if (blocker) {
    const testText =
      testingFollowups.length > 0 ? `; then add or justify \`${testingFollowups[0]?.id}\`` : "";
    return `Fix \`${blocker.id}\`: ${escapeCommentText(findingTitle(blocker.finding))}${testText}.`;
  }
  const warning = records.find((record) => record.finding.severity === "warning");
  if (warning) {
    return `Resolve or justify \`${warning.id}\`: ${escapeCommentText(findingTitle(warning.finding))}.`;
  }
  if (testingFollowups.length > 0) {
    return `Add or justify \`${testingFollowups[0]?.id || "PRA-T1"}\` and any related test follow-ups.`;
  }
  const suggestion = records.find((record) => record.finding.severity === "suggestion");
  if (suggestion) {
    return `Consider \`${suggestion.id}\`: ${escapeCommentText(findingTitle(suggestion.finding))}.`;
  }
  return "No advisor follow-up required beyond maintainer review.";
}

function buildSecondarySummary(
  result?: ReviewAdvisorResult,
  records: FindingRecord[] = [],
): string {
  const sinceLastReview = result?.summary?.sinceLastReview;
  if (sinceLastReview) {
    return `**Since last review:** ${countLabel(sinceLastReview.resolved, "prior item")} resolved · ${countLabel(sinceLastReview.stillApplies, "still applies", "still apply")} · ${countLabel(sinceLastReview.newItems, "new item")} found\n`;
  }
  const topItem = result?.summary?.topItem || topFindingTitle(records);
  return topItem ? `**Top item:** ${escapeCommentText(topItem)}\n` : "";
}

function topFindingTitle(records: FindingRecord[]): string | undefined {
  return (
    records.find((record) => record.finding.severity === "blocker")?.finding.title ||
    records.find((record) => record.finding.severity === "warning")?.finding.title ||
    records.find((record) => record.finding.severity === "suggestion")?.finding.title
  );
}

function renderActionChecklist(
  records: FindingRecord[],
  testingFollowups: TestingFollowupRecord[],
): string {
  if (records.length === 0 && testingFollowups.length === 0) return "";
  const lines = ["", "### Action checklist", ""];
  for (const record of records.filter((item) => item.finding.severity === "blocker").slice(0, 10)) {
    lines.push(formatChecklistFinding(record, "Fix"));
  }
  for (const record of records.filter((item) => item.finding.severity === "warning").slice(0, 10)) {
    lines.push(formatChecklistFinding(record, "Resolve or justify"));
  }
  for (const followup of testingFollowups.slice(0, 8))
    lines.push(formatChecklistFollowup(followup));
  for (const record of records
    .filter((item) => item.finding.severity === "suggestion")
    .slice(0, 10)) {
    lines.push(formatChecklistFinding(record, "In-scope improvement"));
  }
  return `${lines.join("\n")}\n`;
}

function formatChecklistFinding(record: FindingRecord, action: string): string {
  const location = formatInlineLocation(record.finding);
  const locationText = location ? ` in ${location}` : "";
  return `- [ ] \`${record.id}\` ${action}: ${escapeCommentText(findingTitle(record.finding))}${locationText}`;
}

function formatChecklistFollowup(record: TestingFollowupRecord): string {
  return `- [ ] \`${record.id}\` Add or justify test follow-up: ${escapeCommentText(record.followup.label)}`;
}

function renderFindingsIndex(records: FindingRecord[]): string {
  if (records.length === 0) return "";
  const lines = [
    "",
    "### Findings index",
    "",
    "| ID | Severity | Category | Location | Required action |",
    "|---|---|---|---|---|",
  ];
  for (const record of records.slice(0, 20)) {
    const finding = record.finding;
    lines.push(
      `| \`${record.id}\` | ${severityLabel(finding.severity)} | ${escapeCommentText(finding.category || "uncategorized")} | ${formatTableLocation(finding)} | ${escapeCommentText(finding.recommendation || findingTitle(finding))} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderFindingsDetails(records: FindingRecord[]): string {
  if (records.length === 0) return "";
  const blockerFindings = records.filter((record) => record.finding.severity === "blocker");
  const warningFindings = records.filter((record) => record.finding.severity === "warning");
  const suggestionFindings = records.filter((record) => record.finding.severity === "suggestion");
  const lines: string[] = [];
  if (blockerFindings.length > 0) {
    lines.push("", "### 🚨 Required before merge");
    lines.push(
      "_Address these before merging unless a maintainer explicitly overrides the advisor with rationale._",
      "",
    );
    for (const record of blockerFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  if (warningFindings.length === 0 && suggestionFindings.length === 0)
    return `${lines.join("\n")}\n`;
  lines.push(
    "<details>",
    `<summary>Review findings by urgency: ${countLabel(blockerFindings.length, "required fix", "required fixes")}, ${countLabel(warningFindings.length, "item to resolve/justify", "items to resolve/justify")}, ${countLabel(suggestionFindings.length, "in-scope improvement", "in-scope improvements")}</summary>`,
    "",
  );
  lines.push("### ⚠️ Resolve or justify before merge");
  lines.push(
    "_Investigate these in the current review; either fix them, explain why they are not applicable, or document the accepted risk._",
  );
  if (warningFindings.length === 0) {
    lines.push("- _None._");
  } else {
    for (const record of warningFindings.slice(0, 20)) lines.push(formatFinding(record));
  }
  lines.push("", "### 💡 In-scope improvements");
  lines.push(
    "_These are lower-risk, not throwaway. Prefer fixing them in this PR when they are local to changed code; defer only with rationale or a linked follow-up._",
  );
  if (suggestionFindings.length === 0) {
    lines.push("- _None._");
  } else {
    for (const record of suggestionFindings.slice(0, 20)) lines.push(formatFinding(record));
  }
  lines.push("", "</details>", "");
  return `${lines.join("\n")}\n`;
}

function renderSimplificationDetails(records: FindingRecord[]): string {
  const findings = records.filter((record) => record.finding.simplification);
  if (findings.length === 0) return "";
  const netLines = findings.reduce((total, record) => {
    const value = record.finding.simplification?.estimatedNetLines;
    return typeof value === "number" && Number.isFinite(value) ? total + value : total;
  }, 0);
  const netLabel = netLines < 0 ? `, net ${netLines} lines possible` : "";
  const lines: string[] = [
    "",
    "<details>",
    `<summary>Simplification opportunities: ${countLabel(findings.length, "possible cut", "possible cuts")}${netLabel}</summary>`,
    "",
    "_These are safe simplification checks only. Do not remove validation, security controls, data-loss prevention, or required tests._",
  ];
  for (const record of findings.slice(0, 12)) {
    const item = record.finding.simplification;
    if (!item) continue;
    const location = formatFindingLocation(record.finding);
    lines.push(
      `- \`${record.id}\` **${escapeCommentText(item.tag || "shrink")}**${location}: ${escapeCommentText(item.cut || record.finding.title || "Review simplification")}`,
    );
    lines.push(
      `  - Replacement: ${escapeCommentText(item.replacement || "Use the simpler existing path.")}`,
    );
    if (typeof item.estimatedNetLines === "number") {
      lines.push(`  - Net: ${item.estimatedNetLines} lines`);
    }
    lines.push(
      `  - Safety boundary: ${escapeCommentText(item.safetyBoundary || "Keep validation, security, data-loss prevention, and required tests.")}`,
    );
  }
  lines.push("", "</details>", "");
  return `${lines.join("\n")}\n`;
}

function renderTestingFollowupsDetails(records: TestingFollowupRecord[]): string {
  if (records.length === 0) return "";
  const lines: string[] = [
    "",
    "<details>",
    "<summary>Test follow-ups to resolve or justify</summary>",
    "",
    "_If these cover changed behavior, prefer adding them in this PR; otherwise state why existing coverage is enough or link the follow-up._",
  ];
  for (const record of records) lines.push(formatTestingFollowup(record));
  lines.push("", "</details>", "");
  return `${lines.join("\n")}\n`;
}

function collectTestingFollowups(result?: ReviewAdvisorResult): TestingFollowup[] {
  const followups: TestingFollowup[] = [];
  if (!result) return followups;
  if (result.testDepth?.verdict && result.testDepth.verdict !== "unit_sufficient") {
    const label = testDepthLabel(result.testDepth.verdict);
    const rationale = result.testDepth.rationale ? ` ${result.testDepth.rationale}` : "";
    for (const suggestion of result.testDepth.suggestedTests?.slice(0, 5) || []) {
      followups.push({ label, text: `${suggestion}.${rationale}` });
    }
  }
  for (const finding of result.findings?.filter((item) => item.category === "tests").slice(0, 5) ||
    []) {
    followups.push({
      label: finding.title || "Test coverage",
      text:
        finding.recommendation ||
        finding.description ||
        "Add targeted coverage for the changed behavior.",
    });
  }
  for (const clause of result.acceptanceCoverage
    ?.filter((item) => item.status && item.status !== "met")
    .slice(0, 5) || []) {
    followups.push({
      label: "Acceptance clause",
      text: `${clause.clause || "unspecified"} — add test evidence or identify existing coverage. ${clause.evidence || ""}`.trim(),
    });
  }
  for (const review of result.sourceOfTruthReview
    ?.filter((item) => item.status === "missing" || item.status === "needs_followup")
    .slice(0, 5) || []) {
    followups.push({
      label: review.surface || "Localized behavior",
      text: `${review.regressionTest || "add a regression test for the localized behavior"}. ${review.evidence || ""}`.trim(),
    });
  }
  return uniqueTestingFollowups(followups).slice(0, 8);
}

function formatTestingFollowup(record: TestingFollowupRecord): string {
  return `- \`${record.id}\` **${escapeCommentText(record.followup.label)}** — ${escapeCommentText(record.followup.text)}`;
}

function uniqueTestingFollowups(followups: TestingFollowup[]): TestingFollowup[] {
  const seen = new Set<string>();
  const unique: TestingFollowup[] = [];
  for (const followup of followups) {
    const key = `${followup.label}\u0000${followup.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(followup);
  }
  return unique;
}

function testDepthLabel(verdict: string): string {
  if (verdict === "runtime_validation_recommended") return "Runtime validation";
  if (verdict === "mocks_recommended") return "Mocked behavioral coverage";
  return "Test coverage";
}

function renderPreviousReviewDetails(
  result: ReviewAdvisorResult | undefined,
  records: FindingRecord[],
): string {
  const sinceLastReview = result?.summary?.sinceLastReview;
  if (!sinceLastReview || records.length === 0) return "";
  const lines: string[] = ["<details>", "<summary>Since last review details</summary>", ""];
  lines.push("Current findings, using the urgency labels above:");
  for (const record of records.slice(0, 20)) lines.push(formatFinding(record));
  lines.push("", "</details>", "");
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
  const expectedFollowUp = findingExpectedFollowUp(finding.severity);
  if (expectedFollowUp) lines.push(`- **Expected follow-up:** ${expectedFollowUp}`);
  if (finding.verificationHint) {
    lines.push(`- **Verification:** ${escapeCommentText(finding.verificationHint)}`);
  }
  if (finding.missingRegressionTest) {
    lines.push(
      `- **Missing regression test:** ${escapeCommentText(finding.missingRegressionTest)}`,
    );
  }
  lines.push(`- **Done when:** ${doneWhenForFinding(finding)}`);
  if (finding.evidence) lines.push(`- **Evidence:** ${escapeCommentText(finding.evidence)}`);
  return lines.join("\n");
}

function findingTitle(finding: Finding): string {
  return finding.title || "Review finding";
}

function severityLabel(severity?: string): string {
  if (severity === "blocker") return "Required";
  if (severity === "warning") return "Resolve/justify";
  if (severity === "suggestion") return "Improvement";
  return "Review";
}

function actionFieldLabel(severity?: string): string {
  if (severity === "blocker") return "Required action";
  if (severity === "warning") return "Recommended action";
  if (severity === "suggestion") return "Suggested action";
  return "Recommendation";
}

function findingExpectedFollowUp(severity?: string): string {
  if (severity === "blocker") return "Fix before merge or get explicit maintainer override.";
  if (severity === "warning") return "Resolve in this PR or explain why the risk is acceptable.";
  if (severity === "suggestion") {
    return "Prefer a current-PR fix when local to changed code; defer only with rationale or linked follow-up.";
  }
  return "Review and decide whether this PR should act on it.";
}

function doneWhenForFinding(finding: Finding): string {
  if (finding.severity === "blocker") {
    const verification = finding.verificationHint
      ? `and verification passes: ${stripTerminalPunctuation(finding.verificationHint)}`
      : "and the fix is covered by relevant test or review evidence";
    return escapeCommentText(`The required change is committed ${verification}.`);
  }
  if (finding.severity === "warning") {
    const verification = finding.verificationHint
      ? ` Verification: ${stripTerminalPunctuation(finding.verificationHint)}.`
      : "";
    return escapeCommentText(`The risk is fixed or explicitly justified in the PR.${verification}`);
  }
  if (finding.severity === "suggestion") {
    return escapeCommentText(
      "The local improvement is applied, or the PR notes why it should be deferred.",
    );
  }
  return escapeCommentText("The PR records the maintainer decision for this item.");
}

function stripTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/g, "");
}

function formatFindingLocation(finding: Finding): string {
  if (!finding.file) return "";
  const line = Number.isInteger(finding.line) && Number(finding.line) > 0 ? `:${finding.line}` : "";
  return ` (${escapeCommentText(finding.file)}${line})`;
}

function formatInlineLocation(finding: Finding): string {
  if (!finding.file) return "";
  const line = Number.isInteger(finding.line) && Number(finding.line) > 0 ? `:${finding.line}` : "";
  return `<code>${escapeLocationHtml(`${finding.file}${line}`)}</code>`;
}

function formatTableLocation(finding: Finding): string {
  return formatInlineLocation(finding) || "—";
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
